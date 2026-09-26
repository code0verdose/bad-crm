import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  projectListSearchSchema,
  type ProjectListSearch,
} from '@units/project/model/validation/project-list-search.schema.js';

import { useProjectFilters, type ProjectSearchNavigation } from './use-project-filters.hook.js';

/**
 * The filter of `/projects`, without a router (STORY-014-04, acceptances 1–3).
 *
 * The hook decides **what the next URL is** as a function of the current one, which is testable
 * without mounting anything: every filter resets the page, every write replaces, and typing reaches
 * the URL once, after the pause, while the input answers at once.
 */

const TYPING_PAUSE_MS = 300;
const LEAD = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b11';

const searchWith = (overrides: Partial<ProjectListSearch> = {}): ProjectListSearch => ({
  ...projectListSearchSchema.parse({}),
  ...overrides,
});

interface Recorded {
  readonly next: ProjectListSearch;
  readonly replace: boolean;
}

const recorder = () => {
  const calls: Recorded[] = [];
  let current = searchWith();
  const navigate: ProjectSearchNavigation = (input) => {
    calls.push({ next: input.search(current), replace: input.replace });
  };

  return {
    calls,
    navigate,
    startFrom: (search: ProjectListSearch): void => {
      current = search;
    },
  };
};

let nav: ReturnType<typeof recorder>;

const mount = (search: ProjectListSearch) => {
  nav.startFrom(search);

  return renderHook(() => useProjectFilters(search, nav.navigate));
};

beforeEach(() => {
  vi.useFakeTimers();
  nav = recorder();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('changing a filter', () => {
  it.each([
    ['a status', (f: ReturnType<typeof useProjectFilters>) => f.setStatuses(['ON_HOLD'])],
    ['the lead', (f: ReturnType<typeof useProjectFilters>) => f.setLead(LEAD)],
    ['«my projects»', (f: ReturnType<typeof useProjectFilters>) => f.setMine(true)],
    ['the order', (f: ReturnType<typeof useProjectFilters>) => f.setSort('-createdAt')],
  ])('resets the page when %s changes, and replaces the entry', (_name, change) => {
    const { result } = mount(searchWith({ page: 3 }));

    act(() => {
      change(result.current);
    });

    expect(nav.calls).toHaveLength(1);
    expect(nav.calls[0]?.next.page).toBe(1);
    expect(nav.calls[0]?.replace).toBe(true);
  });

  it('writes what was chosen, keeping the rest', () => {
    const { result } = mount(searchWith({ view: 'table', status: ['ACTIVE'] }));

    act(() => {
      result.current.setLead(LEAD);
    });

    expect(nav.calls[0]?.next).toMatchObject({ lead: LEAD, status: ['ACTIVE'], view: 'table' });
  });

  it('takes the lead and «my projects» off with an empty choice', () => {
    const { result } = mount(searchWith({ lead: LEAD, member: 'me' }));

    act(() => {
      result.current.setLead(null);
      result.current.setMine(false);
    });

    expect(nav.calls[0]?.next.lead).toBeUndefined();
    expect(nav.calls[1]?.next.member).toBeUndefined();
    expect(nav.calls.map((call) => call.next.page)).toEqual([1, 1]);
  });

  it('sets «my projects» as the word the server resolves, never an id', () => {
    const { result } = mount(searchWith());

    act(() => {
      result.current.setMine(true);
    });

    expect(nav.calls[0]?.next.member).toBe('me');
  });
});

describe('what is not a filter', () => {
  it('turns the page without touching anything else', () => {
    const { result } = mount(searchWith({ status: ['CLOSED'], page: 2 }));

    act(() => {
      result.current.setPage(5);
    });

    expect(nav.calls[0]).toEqual({
      next: searchWith({ status: ['CLOSED'], page: 5 }),
      replace: true,
    });
  });

  it('switches between cards and the table, keeping the page', () => {
    const { result } = mount(searchWith({ page: 4 }));

    act(() => {
      result.current.setView('table');
    });

    expect(nav.calls[0]?.next).toMatchObject({ view: 'table', page: 4 });
    expect(nav.calls[0]?.replace).toBe(true);
  });
});

describe('typing in the search box', () => {
  it('answers immediately and writes the URL once, after the pause', () => {
    const { result } = mount(searchWith({ page: 2 }));

    act(() => {
      result.current.setQuery('b');
      result.current.setQuery('ba');
      result.current.setQuery('bad');
    });

    expect(result.current.typed).toBe('bad');
    expect(nav.calls).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(TYPING_PAUSE_MS - 1);
    });

    expect(nav.calls).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(nav.calls).toHaveLength(1);
    expect(nav.calls[0]?.next).toMatchObject({ q: 'bad', page: 1 });
  });

  it('clears the search as «no search», not as an empty one', () => {
    const { result } = mount(searchWith({ q: 'bad' }));

    act(() => {
      result.current.setQuery('');
      vi.advanceTimersByTime(TYPING_PAUSE_MS);
    });

    expect(nav.calls[0]?.next.q).toBeUndefined();
  });

  it('starts the input from the URL', () => {
    const { result } = mount(searchWith({ q: 'bad' }));

    expect(result.current.typed).toBe('bad');
  });
});

describe('the active filters', () => {
  it('lists each filter as a chip, by a stable id and a translation key', () => {
    const { result } = mount(
      searchWith({ q: 'bad', status: ['ACTIVE', 'ON_HOLD'], lead: LEAD, member: 'me' }),
    );

    expect(result.current.active).toEqual([
      { id: 'q', labelKey: 'projects.list.filters.chip.query' },
      { id: 'status:ACTIVE', labelKey: 'projects.status.ACTIVE' },
      { id: 'status:ON_HOLD', labelKey: 'projects.status.ON_HOLD' },
      { id: 'lead', labelKey: 'projects.list.filters.chip.lead' },
      { id: 'member', labelKey: 'projects.list.filters.chip.mine' },
    ]);
    expect(result.current.isFiltered).toBe(true);
  });

  it('is not filtered by the order or the view alone', () => {
    const { result } = mount(searchWith({ sort: '-name', view: 'table' }));

    expect(result.current.active).toEqual([]);
    expect(result.current.isFiltered).toBe(false);
  });

  it.each([
    ['q', { q: undefined }],
    ['lead', { lead: undefined }],
    ['member', { member: undefined }],
    ['status:ACTIVE', { status: ['ON_HOLD'] }],
  ])('takes «%s» off alone and starts again from page one', (id, expected) => {
    const { result } = mount(
      searchWith({ q: 'bad', status: ['ACTIVE', 'ON_HOLD'], lead: LEAD, member: 'me', page: 3 }),
    );

    act(() => {
      result.current.removeFilter(id);
    });

    expect(nav.calls[0]?.next).toMatchObject({ ...expected, page: 1 });
    expect(result.current.active).toHaveLength(5);
  });

  it('empties the input when the search chip is taken off', () => {
    const { result } = mount(searchWith({ q: 'bad' }));

    act(() => {
      result.current.removeFilter('q');
    });

    expect(result.current.typed).toBe('');
  });

  it('ignores an id it did not hand out', () => {
    const { result } = mount(searchWith({ status: ['ACTIVE'] }));

    act(() => {
      result.current.removeFilter('status:DELETED');
      result.current.removeFilter('client');
    });

    expect(nav.calls).toEqual([]);
  });
});

describe('resetting', () => {
  it('takes every filter off, keeps the view, and cancels a search still being typed', () => {
    const { result } = mount(
      searchWith({
        q: 'bad',
        status: ['ACTIVE'],
        lead: LEAD,
        member: 'me',
        page: 3,
        view: 'table',
      }),
    );

    act(() => {
      result.current.setQuery('badger');
      result.current.reset();
      vi.advanceTimersByTime(TYPING_PAUSE_MS);
    });

    // One write: the pending keystrokes do not land after the reset and bring the search back.
    expect(nav.calls).toHaveLength(1);
    expect(nav.calls[0]?.next).toMatchObject({ status: [], page: 1, view: 'table', sort: 'name' });
    expect(nav.calls[0]?.next.q).toBeUndefined();
    expect(nav.calls[0]?.next.lead).toBeUndefined();
    expect(nav.calls[0]?.next.member).toBeUndefined();
    expect(result.current.typed).toBe('');
  });
});

describe('the request', () => {
  it('carries every filter of the URL, absent ones as null, and the screen’s page size', () => {
    const { result } = mount(searchWith({ status: ['CLOSED'], sort: 'key', page: 2, perPage: 50 }));

    expect(result.current.params).toEqual({
      q: null,
      status: ['CLOSED'],
      lead: null,
      member: null,
      sort: 'key',
      page: 2,
      perPage: 50,
    });
  });

  it('carries a search, a lead and «me» when they are set', () => {
    const { result } = mount(searchWith({ q: 'bad', lead: LEAD, member: 'me' }));

    expect(result.current.params).toMatchObject({ q: 'bad', lead: LEAD, member: 'me' });
  });
});
