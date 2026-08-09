import { useDebouncedCallback } from '@mantine/hooks';
import { useCallback, useState } from 'react';

import {
  type TeamListSearch,
  type TeamSort,
} from '@units/team/model/validation/team-list-search.schema.js';

/**
 * How long the screen waits before a keystroke becomes a URL.
 *
 * `rules/lists-and-filters.mdc` §6 asks for the pause because a phrase usually becomes a request;
 * here it does not — `GET /teams` takes no parameters — and the pause is still right, for the other
 * half of the same rule: six keystrokes must not become six writes to the address bar.
 */
const TYPING_PAUSE_MS = 300;

/**
 * Writing to the address bar, in the shape the router gives a screen.
 *
 * Passed in rather than taken from `useNavigate()`, so this hook can be tested without a router —
 * and so that `units/` does not reach into the generated route tree, which lives in `app/`, two
 * layers above it.
 */
export interface SearchNavigation {
  (input: { search: (previous: TeamListSearch) => TeamListSearch; replace: boolean }): void;
}

export interface TeamFilters {
  /** What is in the URL right now — including the phrase before the pause elapses. */
  readonly search: TeamListSearch;
  /** What the input shows, which runs ahead of the URL while somebody is typing. */
  readonly typed: string;
  readonly setQuery: (value: string) => void;
  readonly setSort: (value: TeamSort) => void;
  readonly setPage: (page: number) => void;
  readonly reset: () => void;
  /** Whether anything is narrowing the list — what the «reset» affordance appears for. */
  readonly isFiltered: boolean;
}

/**
 * The team list's filter: the URL is the state, and this is the only place that writes it.
 *
 * Three properties are why this is a hook of the unit rather than a handful of handlers on the
 * screen (`rules/lists-and-filters.mdc`):
 *
 *   * **every filter change resets the page.** Page two of «everybody» is not page two of «design»,
 *     and a list that keeps the number shows the end of a list that no longer has one. One place to
 *     change a filter means one place that resets;
 *   * **every write is `replace`.** Six keystrokes must not become six entries in the history,
 *     because the back button then walks the letters of a word instead of leaving the screen;
 *   * **typing is debounced in the handler, not in an effect.** An effect mirroring state into the
 *     URL is the derived-state effect `rules/frontend-fsd.mdc` rule 11 forbids, and it would also
 *     fire on arrival — rewriting the address the moment somebody follows a link to it.
 */
export const useTeamFilters = (search: TeamListSearch, navigate: SearchNavigation): TeamFilters => {
  const [typed, setTyped] = useState(search.q);

  const applyFilter = useCallback(
    (change: Partial<TeamListSearch>): void => {
      navigate({
        // `page: 1` **after** the change, so a filter cannot bring its own page number with it.
        search: (previous) => ({ ...previous, ...change, page: 1 }),
        replace: true,
      });
    },
    [navigate],
  );

  const publishQuery = useDebouncedCallback((value: string) => {
    applyFilter({ q: value });
  }, TYPING_PAUSE_MS);

  const setQuery = useCallback(
    (value: string): void => {
      // The input is controlled from here so it answers instantly; the URL follows after the pause.
      setTyped(value);
      publishQuery(value);
    },
    [publishQuery],
  );

  const setSort = useCallback(
    (value: TeamSort): void => {
      applyFilter({ sort: value });
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

  const reset = useCallback((): void => {
    // Both the field and the URL: clearing only the URL leaves a stale phrase in the input, which
    // then reads as a filter that is on while the list shows everything.
    setTyped('');
    applyFilter({ q: '', sort: 'name' });
  }, [applyFilter]);

  return {
    search,
    typed,
    setQuery,
    setSort,
    setPage,
    reset,
    /**
     * The order is deliberately not counted.
     *
     * «Reset the filters» must not silently reorder a table under somebody's cursor — an order is
     * how the rows are read, not which rows they are. `reset` does put it back, because that is the
     * one gesture that says «start again».
     */
    isFiltered: search.q !== '',
  };
};
