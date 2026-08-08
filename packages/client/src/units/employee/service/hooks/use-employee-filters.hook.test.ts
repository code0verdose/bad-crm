import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  memberListSearchSchema,
  type MemberListSearch,
} from '@units/employee/model/validation/member-list-search.schema.js';

import { useEmployeeFilters } from './use-employee-filters.hook.js';

/**
 * The filter of the directory, without a router.
 *
 * The hook takes `navigate` as an argument for exactly this: what it does is decide **what the next
 * URL is**, and that is testable as a function of the current one. Three properties carry it:
 *
 *   * every filter change resets the page — page four of «everybody» is not page four of «the
 *     platform team», and a list that keeps the number shows an empty table after a filter that
 *     matched plenty;
 *   * every write replaces rather than pushes — six keystrokes must not become six entries in the
 *     history;
 *   * typing reaches the URL once, after a pause, and the input answers immediately meanwhile.
 */

const TYPING_PAUSE_MS = 300;

const searchWith = (overrides: Partial<MemberListSearch> = {}): MemberListSearch => ({
  ...memberListSearchSchema.parse({}),
  ...overrides,
});

interface Recorded {
  readonly next: MemberListSearch;
  readonly replace: boolean;
}

const recorder = () => {
  const calls: Recorded[] = [];
  const navigate = (input: {
    search: (previous: MemberListSearch) => MemberListSearch;
    replace: boolean;
  }): void => {
    calls.push({ next: input.search(current), replace: input.replace });
  };
  let current = searchWith();

  return {
    calls,
    navigate,
    startFrom: (search: MemberListSearch): void => {
      current = search;
    },
  };
};

let nav: ReturnType<typeof recorder>;

beforeEach(() => {
  vi.useFakeTimers();
  nav = recorder();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('changing a filter', () => {
  it('resets the page, whatever page the reader was on', () => {
    const search = searchWith({ page: 4 });

    nav.startFrom(search);

    const { result } = renderHook(() => useEmployeeFilters(search, nav.navigate));

    act(() => {
      result.current.setStatuses(['SUSPENDED']);
    });

    expect(nav.calls[0]?.next).toMatchObject({ status: ['SUSPENDED'], page: 1 });
  });

  it('replaces the entry rather than pushing a new one', () => {
    const { result } = renderHook(() => useEmployeeFilters(searchWith(), nav.navigate));

    act(() => {
      result.current.setSort('-name');
    });

    expect(nav.calls[0]?.replace).toBe(true);
  });

  it('adds a team and takes the same one off again', () => {
    const search = searchWith({ team: ['t-1'] });

    nav.startFrom(search);

    const { result } = renderHook(() => useEmployeeFilters(search, nav.navigate));

    act(() => {
      result.current.toggleTeam('t-2');
    });

    expect(nav.calls[0]?.next.team).toEqual(['t-1', 't-2']);

    act(() => {
      result.current.toggleTeam('t-1');
    });

    expect(nav.calls[1]?.next.team).toEqual([]);
  });

  it('adds a role and takes the same one off again', () => {
    const search = searchWith();

    nav.startFrom(search);

    const { result } = renderHook(() => useEmployeeFilters(search, nav.navigate));

    act(() => {
      result.current.toggleRole('r-1');
    });

    expect(nav.calls[0]?.next.role).toEqual(['r-1']);

    nav.startFrom(searchWith({ role: ['r-1'] }));

    act(() => {
      result.current.toggleRole('r-1');
    });

    expect(nav.calls[1]?.next.role).toEqual([]);
  });
});

describe('typing in the search box', () => {
  it('answers immediately and writes the URL once, after the pause', () => {
    const { result } = renderHook(() => useEmployeeFilters(searchWith(), nav.navigate));

    act(() => {
      result.current.setQuery('и');
      result.current.setQuery('ив');
      result.current.setQuery('ива');
    });

    // The input is already showing what was typed; the address bar has not moved.
    expect(result.current.typed).toBe('ива');
    expect(nav.calls).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(TYPING_PAUSE_MS);
    });

    expect(nav.calls).toHaveLength(1);
    expect(nav.calls[0]?.next).toMatchObject({ q: 'ива', page: 1 });
  });
});

describe('paging', () => {
  it('is the one change that keeps the filters and the page number it was given', () => {
    const search = searchWith({ q: 'ив', page: 1 });

    nav.startFrom(search);

    const { result } = renderHook(() => useEmployeeFilters(search, nav.navigate));

    act(() => {
      result.current.setPage(3);
    });

    expect(nav.calls[0]?.next).toMatchObject({ q: 'ив', page: 3 });
  });
});

describe('switching the view', () => {
  it('keeps the page, because it does not change which people are shown', () => {
    const search = searchWith({ page: 2 });

    nav.startFrom(search);

    const { result } = renderHook(() => useEmployeeFilters(search, nav.navigate));

    act(() => {
      result.current.setView('chart');
    });

    expect(nav.calls[0]?.next).toMatchObject({ view: 'chart', page: 2 });
  });
});

describe('what counts as «filtered»', () => {
  it.each([
    ['a search', { q: 'ив' }],
    ['a status', { status: ['ACTIVE' as const] }],
    ['a role', { role: ['r-1'] }],
    ['a team', { team: ['t-1'] }],
  ])('says yes to %s', (_name, overrides) => {
    const { result } = renderHook(() => useEmployeeFilters(searchWith(overrides), nav.navigate));

    expect(result.current.isFiltered).toBe(true);
  });

  it('says no to an order, which changes how the rows read and not which they are', () => {
    // «Reset the filters» must not silently reorder the table under somebody's cursor.
    const { result } = renderHook(() =>
      useEmployeeFilters(searchWith({ sort: '-hiredAt' }), nav.navigate),
    );

    expect(result.current.isFiltered).toBe(false);
  });
});

describe('resetting', () => {
  it('clears the box on screen as well as the one in the URL', () => {
    const search = searchWith({ q: 'ив', role: ['r-1'], sort: '-name' });

    nav.startFrom(search);

    const { result } = renderHook(() => useEmployeeFilters(search, nav.navigate));

    act(() => {
      result.current.reset();
    });

    expect(result.current.typed).toBe('');
    expect(nav.calls[0]?.next).toMatchObject({
      q: '',
      role: [],
      status: [],
      team: [],
      sort: 'name',
      page: 1,
    });
  });
});
