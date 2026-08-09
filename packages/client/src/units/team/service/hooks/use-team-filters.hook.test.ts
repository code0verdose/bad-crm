import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  teamListSearchSchema,
  type TeamListSearch,
} from '@units/team/model/validation/team-list-search.schema.js';

import { useTeamFilters } from './use-team-filters.hook.js';

/**
 * The filter of the team list, without a router.
 *
 * The hook takes `navigate` as an argument for exactly this reason: what it does is decide **what
 * the next URL is**, and that is a function of the current one. The three properties
 * `rules/lists-and-filters.mdc` asks for are all statements about that function:
 *
 *   * a filter change resets the page — page two of «everybody» is not page two of «design», and a
 *     list that keeps the number shows the end of a list that no longer has one;
 *   * every write replaces rather than pushes — six keystrokes must not become six entries in the
 *     history, or the back button walks the letters of a word instead of leaving the screen;
 *   * typing reaches the address bar once, after a pause, while the input answers immediately.
 */

const TYPING_PAUSE_MS = 300;

const searchWith = (overrides: Partial<TeamListSearch> = {}): TeamListSearch => ({
  ...teamListSearchSchema.parse({}),
  ...overrides,
});

interface Recorded {
  readonly next: TeamListSearch;
  readonly replace: boolean;
}

const recorder = () => {
  const calls: Recorded[] = [];
  let current = searchWith();

  return {
    calls,
    navigate: (input: {
      search: (previous: TeamListSearch) => TeamListSearch;
      replace: boolean;
    }): void => {
      calls.push({ next: input.search(current), replace: input.replace });
    },
    startFrom: (search: TeamListSearch): void => {
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

describe('typing a phrase', () => {
  it('answers in the field immediately and reaches the URL once, after the pause', () => {
    const { result } = renderHook(() => useTeamFilters(searchWith(), nav.navigate));

    act(() => {
      result.current.setQuery('des');
    });
    act(() => {
      result.current.setQuery('desi');
    });

    // The input is controlled from the hook, so it does not wait for the address bar.
    expect(result.current.typed).toBe('desi');
    expect(nav.calls).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(TYPING_PAUSE_MS);
    });

    expect(nav.calls).toHaveLength(1);
    expect(nav.calls[0]?.next.q).toBe('desi');
  });

  it('resets the page, because a phrase does not know which page the reader was on', () => {
    nav.startFrom(searchWith({ page: 3 }));

    const { result } = renderHook(() => useTeamFilters(searchWith({ page: 3 }), nav.navigate));

    act(() => {
      result.current.setQuery('des');
      vi.advanceTimersByTime(TYPING_PAUSE_MS);
    });

    expect(nav.calls[0]?.next.page).toBe(1);
  });
});

describe('changing the order', () => {
  it('resets the page and replaces the entry', () => {
    nav.startFrom(searchWith({ page: 4 }));

    const { result } = renderHook(() => useTeamFilters(searchWith({ page: 4 }), nav.navigate));

    act(() => {
      result.current.setSort('-members');
    });

    expect(nav.calls[0]?.next).toMatchObject({ sort: '-members', page: 1 });
    expect(nav.calls[0]?.replace).toBe(true);
  });
});

describe('turning the page', () => {
  /**
   * The one change that is not a filter, and the only one that keeps the rest as it is. Resetting
   * the page here would make the pager unable to do the single thing it exists for.
   */
  it('keeps the phrase and the order', () => {
    const search = searchWith({ q: 'des', sort: '-name' });
    nav.startFrom(search);

    const { result } = renderHook(() => useTeamFilters(search, nav.navigate));

    act(() => {
      result.current.setPage(2);
    });

    expect(nav.calls[0]?.next).toMatchObject({ q: 'des', sort: '-name', page: 2 });
  });
});

describe('resetting', () => {
  it('empties the field it controls as well as the URL', () => {
    const search = searchWith({ q: 'des', sort: '-members', page: 3 });
    nav.startFrom(search);

    const { result } = renderHook(() => useTeamFilters(search, nav.navigate));

    act(() => {
      result.current.reset();
    });

    // Both, and that is the point: clearing only the URL leaves the stale phrase in the input, which
    // then reads as a filter that is on while the list shows everything.
    expect(result.current.typed).toBe('');
    expect(nav.calls[0]?.next).toMatchObject({ q: '', sort: 'name', page: 1 });
  });
});

describe('whether anything is narrowing the list', () => {
  it.each([
    ['nothing typed', searchWith(), false],
    ['a phrase', searchWith({ q: 'des' }), true],
    // An order is how the rows are read, not which rows they are: «reset the filters» must not
    // silently reorder a table under somebody's cursor, so it does not count as one.
    ['only a different order', searchWith({ sort: '-members' }), false],
  ])('%s', (_case, search, expected) => {
    const { result } = renderHook(() => useTeamFilters(search, nav.navigate));

    expect(result.current.isFiltered).toBe(expected);
  });
});
