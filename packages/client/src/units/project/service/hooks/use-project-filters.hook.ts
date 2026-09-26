import { useDebouncedCallback } from '@mantine/hooks';
import { useCallback, useState } from 'react';

import { type ProjectListParams } from '@units/project/api';
import {
  projectActiveFilters,
  STATUS_CHIP_PREFIX,
  type ProjectActiveFilter,
} from '@units/project/lib/utils/project-active-filters.util.js';
import { type ProjectStatus } from '@units/project/model/enums/project-status.enums.js';
import {
  type ProjectListSearch,
  type ProjectListSort,
  type ProjectListView,
} from '@units/project/model/validation/project-list-search.schema.js';

/**
 * How long the screen waits before a keystroke becomes a URL and a request — the directory's pause
 * (`use-employee-filters.hook.ts`), and debounced in the **handler**, for its reason: the address
 * bar is the state, so the write is what has to wait (`rules/lists-and-filters.mdc` §6).
 */
const TYPING_PAUSE_MS = 300;

/**
 * Writing to the address bar, in the shape the router gives a screen. Passed in, so the hook is
 * testable without a router and `units/` does not reach into the route tree two layers above it.
 */
export interface ProjectSearchNavigation {
  (input: { search: (previous: ProjectListSearch) => ProjectListSearch; replace: boolean }): void;
}

export interface ProjectFilters {
  /** What is in the URL right now — including the search text before the pause elapses. */
  readonly search: ProjectListSearch;
  /** What the input shows, which runs ahead of the URL while somebody is typing. */
  readonly typed: string;
  readonly setQuery: (value: string) => void;
  readonly setStatuses: (values: readonly ProjectStatus[]) => void;
  readonly setLead: (leadId: string | null) => void;
  readonly setMine: (mine: boolean) => void;
  readonly setSort: (value: ProjectListSort) => void;
  readonly setPage: (page: number) => void;
  readonly setView: (view: ProjectListView) => void;
  /** Takes off the one filter a chip stands for, by the id `active` handed out. */
  readonly removeFilter: (id: string) => void;
  readonly reset: () => void;
  /** What is narrowing the list, in the order the controls stand. */
  readonly active: readonly ProjectActiveFilter[];
  readonly isFiltered: boolean;
  /** The filter as the API takes it — and as the query key spells it. */
  readonly params: ProjectListParams;
}

/**
 * The filter of `/projects`: the URL is the state, and this is the only place that writes it
 * (STORY-014-04, acceptances 1–3).
 *
 * Every filter change resets the page, every write is `replace`, and typing waits for a pause — the
 * three properties the directory's hook has, for the same reasons. Sort counts as a filter for the
 * page (page four of «by name» is not page four of «newest first») but not for «is the list
 * narrowed»: an order is how the rows are read, not which rows they are.
 */
export const useProjectFilters = (
  search: ProjectListSearch,
  navigate: ProjectSearchNavigation,
): ProjectFilters => {
  const [typed, setTyped] = useState(search.q ?? '');

  const applyFilter = useCallback(
    (change: (previous: ProjectListSearch) => Partial<ProjectListSearch>): void => {
      navigate({
        // `page: 1` **after** the change, so a filter cannot bring its own page number with it.
        search: (previous) => ({ ...previous, ...change(previous), page: 1 }),
        replace: true,
      });
    },
    [navigate],
  );

  const publishQuery = useDebouncedCallback((value: string) => {
    applyFilter(() => ({ q: value.trim() === '' ? undefined : value }));
  }, TYPING_PAUSE_MS);

  const setQuery = useCallback(
    (value: string): void => {
      setTyped(value);
      publishQuery(value);
    },
    [publishQuery],
  );

  const setStatuses = useCallback(
    (values: readonly ProjectStatus[]): void => {
      applyFilter(() => ({ status: [...values] }));
    },
    [applyFilter],
  );

  const setLead = useCallback(
    (leadId: string | null): void => {
      applyFilter(() => ({ lead: leadId ?? undefined }));
    },
    [applyFilter],
  );

  const setMine = useCallback(
    (mine: boolean): void => {
      applyFilter(() => ({ member: mine ? 'me' : undefined }));
    },
    [applyFilter],
  );

  const setSort = useCallback(
    (value: ProjectListSort): void => {
      applyFilter(() => ({ sort: value }));
    },
    [applyFilter],
  );

  /** The one change that keeps everything else as it is. */
  const setPage = useCallback(
    (page: number): void => {
      navigate({ search: (previous) => ({ ...previous, page }), replace: true });
    },
    [navigate],
  );

  /** Not a filter: which projects are shown does not change, only how — so the page stays. */
  const setView = useCallback(
    (view: ProjectListView): void => {
      navigate({ search: (previous) => ({ ...previous, view }), replace: true });
    },
    [navigate],
  );

  const removeFilter = useCallback(
    (id: string): void => {
      if (id === 'q') {
        publishQuery.cancel();
        setTyped('');
        applyFilter(() => ({ q: undefined }));
      } else if (id === 'lead') {
        applyFilter(() => ({ lead: undefined }));
      } else if (id === 'member') {
        applyFilter(() => ({ member: undefined }));
      } else if (id.startsWith(STATUS_CHIP_PREFIX)) {
        const status = id.slice(STATUS_CHIP_PREFIX.length);

        // An id this hook did not hand out changes nothing — and writes nothing.
        if (search.status.some((value) => value === status)) {
          applyFilter((previous) => ({
            status: previous.status.filter((value) => value !== status),
          }));
        }
      }
    },
    [applyFilter, publishQuery, search.status],
  );

  const reset = useCallback((): void => {
    // A keystroke still waiting for its pause would otherwise land after the reset and bring the
    // search it was typing back.
    publishQuery.cancel();
    setTyped('');
    applyFilter(() => ({
      q: undefined,
      status: [],
      lead: undefined,
      member: undefined,
      sort: 'name',
    }));
  }, [applyFilter, publishQuery]);

  const active = projectActiveFilters(search);

  return {
    search,
    typed,
    setQuery,
    setStatuses,
    setLead,
    setMine,
    setSort,
    setPage,
    setView,
    removeFilter,
    reset,
    active,
    isFiltered: active.length > 0,
    params: {
      q: search.q ?? null,
      status: search.status,
      lead: search.lead ?? null,
      member: search.member ?? null,
      sort: search.sort,
      page: search.page,
      perPage: search.perPage,
    },
  };
};
