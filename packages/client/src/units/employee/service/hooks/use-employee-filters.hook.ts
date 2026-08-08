import { useDebouncedCallback } from '@mantine/hooks';
import { useCallback, useState } from 'react';

import {
  type EmployeeListParams,
  type EmployeeSort,
  type EmployeeStatus,
} from '@units/employee/api';
import {
  MEMBERS_PER_PAGE,
  type MemberListSearch,
  type MemberView,
} from '@units/employee/model/validation/member-list-search.schema.js';

/**
 * How long the screen waits before a keystroke becomes a URL and a request.
 *
 * Both at once, and that is the point: the address bar is the state, so debouncing the request
 * without debouncing the address would leave the two disagreeing for 300 ms — and debouncing the
 * address alone would still send a request per character.
 */
const TYPING_PAUSE_MS = 300;

/**
 * Writing to the address bar, in the shape the router gives a screen.
 *
 * Passed in rather than taken from `useNavigate()` so that this hook can be tested without a router
 * — and so that `units/` does not reach into the generated route tree, which lives in `app/` and is
 * two layers above it.
 */
export interface SearchNavigation {
  (input: { search: (previous: MemberListSearch) => MemberListSearch; replace: boolean }): void;
}

export interface EmployeeFilters {
  /** What is in the URL right now — including the search text before the pause elapses. */
  readonly search: MemberListSearch;
  /** What the input shows, which runs ahead of the URL while somebody is typing. */
  readonly typed: string;
  readonly setQuery: (value: string) => void;
  readonly setStatuses: (values: readonly EmployeeStatus[]) => void;
  readonly toggleRole: (roleId: string) => void;
  readonly toggleTeam: (teamId: string) => void;
  readonly setSort: (value: EmployeeSort) => void;
  readonly setPage: (page: number) => void;
  readonly setView: (view: MemberView) => void;
  readonly reset: () => void;
  /** Whether anything is narrowing the list — what the «reset» affordance appears for. */
  readonly isFiltered: boolean;
  /** The filter as the API takes it. */
  readonly params: EmployeeListParams;
}

/**
 * The directory's filter: the URL is the state, and this is the only place that writes it.
 *
 * Three properties are the reason this is a hook of the unit rather than a handful of handlers on
 * the screen (`rules/lists-and-filters.mdc`):
 *
 *   * **every filter change resets the page.** Page four of «everybody» is not page four of «the
 *     platform team», and a list that keeps the number shows an empty table after a filter that
 *     matched plenty. One place to change a filter means one place that resets;
 *   * **every write is `replace`.** Six keystrokes must not become six entries in the history,
 *     because the back button then walks the letters of a word instead of leaving the screen;
 *   * **typing is debounced in the handler, not in an effect.** An effect mirroring state into the
 *     URL is the derived-state effect `rules/frontend-fsd.mdc` rule 11 forbids, and it would also
 *     fire on arrival — rewriting the address the moment somebody follows a link to it.
 */
export const useEmployeeFilters = (
  search: MemberListSearch,
  navigate: SearchNavigation,
): EmployeeFilters => {
  const [typed, setTyped] = useState(search.q);

  const applyFilter = useCallback(
    (change: (previous: MemberListSearch) => Partial<MemberListSearch>): void => {
      navigate({
        // `page: 1` **after** the change, so a filter cannot bring its own page number with it.
        search: (previous) => ({ ...previous, ...change(previous), page: 1 }),
        replace: true,
      });
    },
    [navigate],
  );

  const publishQuery = useDebouncedCallback((value: string) => {
    applyFilter(() => ({ q: value }));
  }, TYPING_PAUSE_MS);

  const setQuery = useCallback(
    (value: string): void => {
      // The input is controlled from here so it answers instantly; the URL follows after the pause.
      setTyped(value);
      publishQuery(value);
    },
    [publishQuery],
  );

  const setStatuses = useCallback(
    (values: readonly EmployeeStatus[]): void => {
      applyFilter(() => ({ status: [...values] }));
    },
    [applyFilter],
  );

  const toggleRole = useCallback(
    (roleId: string): void => {
      applyFilter((previous) => ({ role: toggled(previous.role, roleId) }));
    },
    [applyFilter],
  );

  const toggleTeam = useCallback(
    (teamId: string): void => {
      applyFilter((previous) => ({ team: toggled(previous.team, teamId) }));
    },
    [applyFilter],
  );

  const setSort = useCallback(
    (value: EmployeeSort): void => {
      applyFilter(() => ({ sort: value }));
    },
    [applyFilter],
  );

  /** The one change that is **not** a filter, and the only one that keeps the rest as it is. */
  const setPage = useCallback(
    (page: number): void => {
      navigate({ search: (previous) => ({ ...previous, page }), replace: true });
    },
    [navigate],
  );

  /**
   * Switching between the table and the chart keeps the page and the filters.
   *
   * Not a filter: it does not change which people are shown, only how. Resetting the page here would
   * mean glancing at the chart and coming back to the top of a list somebody had scrolled to.
   */
  const setView = useCallback(
    (view: MemberView): void => {
      navigate({ search: (previous) => ({ ...previous, view }), replace: true });
    },
    [navigate],
  );

  const reset = useCallback((): void => {
    setTyped('');
    applyFilter(() => ({ q: '', status: [], role: [], team: [], sort: 'name' }));
  }, [applyFilter]);

  return {
    search,
    typed,
    setQuery,
    setStatuses,
    toggleRole,
    toggleTeam,
    setSort,
    setPage,
    setView,
    reset,
    isFiltered: isFiltered(search),
    params: {
      q: search.q,
      status: search.status,
      role: search.role,
      team: search.team,
      sort: search.sort,
      page: search.page,
      perPage: MEMBERS_PER_PAGE,
    },
  };
};

/** In or out, and never twice in: a selected value clicked again is a value taken off. */
const toggled = (values: readonly string[], value: string): string[] =>
  values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];

/**
 * The sort is not counted as a filter here.
 *
 * «Reset the filters» must not silently reorder the table under somebody's cursor — an order is how
 * the rows are read, not which rows they are. `reset` does put it back, because it is the one
 * gesture that says «start again».
 */
const isFiltered = (search: MemberListSearch): boolean =>
  search.q !== '' || search.status.length > 0 || search.role.length > 0 || search.team.length > 0;
