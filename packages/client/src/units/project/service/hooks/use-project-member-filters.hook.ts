import { useDebouncedCallback } from '@mantine/hooks';
import { useCallback, useState } from 'react';

import { type ProjectActiveFilter } from '@units/project/lib/utils/project-active-filters.util.js';
import {
  projectMemberActiveFilters,
  ROLE_CHIP_PREFIX,
} from '@units/project/lib/utils/project-member-active-filters.util.js';
import { PROJECT_ROLES, type ProjectRole } from '@units/project/model/enums/project-role.enums.js';
import { type ProjectMembersSearch } from '@units/project/model/validation/project-members-search.schema.js';

/** The directory's pause (`use-employee-filters.hook.ts`), debounced in the handler for its reason. */
const TYPING_PAUSE_MS = 300;

/** The whitelist the URL is written through, so a select cannot widen it. */
const isRole = (value: string): value is ProjectRole =>
  (PROJECT_ROLES as readonly string[]).includes(value);

/**
 * Writing to the address bar, in the shape the router gives a screen. Passed in, so the hook is
 * testable without a router and `units/` does not reach into the route tree two layers above it.
 */
export interface ProjectMembersSearchNavigation {
  (input: {
    search: (previous: ProjectMembersSearch) => ProjectMembersSearch;
    replace: boolean;
  }): void;
}

export interface ProjectMemberFilters {
  /** What is in the URL right now — including the phrase before the pause elapses. */
  readonly search: ProjectMembersSearch;
  /** What the input shows, which runs ahead of the URL while somebody is typing. */
  readonly typed: string;
  readonly setQuery: (value: string) => void;
  /** Takes whatever the chips hand it; the whitelist is applied here, not in a component. */
  readonly setRoles: (values: readonly string[]) => void;
  /** Takes off the one filter a chip stands for, by the id `active` handed out. */
  readonly removeFilter: (id: string) => void;
  readonly reset: () => void;
  readonly active: readonly ProjectActiveFilter[];
  readonly isFiltered: boolean;
}

/**
 * The roster's filter: the URL is the state, and this is the only place that writes it
 * (STORY-014-02, acceptance 10; `rules/lists-and-filters.mdc` §4, §6, §7).
 *
 * Every write is `replace`, and typing waits for a pause — the directory's two properties. There is
 * no page, so nothing to reset: the roster arrives whole (`project-members-search.schema.ts`).
 */
export const useProjectMemberFilters = (
  search: ProjectMembersSearch,
  navigate: ProjectMembersSearchNavigation,
): ProjectMemberFilters => {
  const [typed, setTyped] = useState(search.q ?? '');

  const apply = useCallback(
    (change: (previous: ProjectMembersSearch) => Partial<ProjectMembersSearch>): void => {
      navigate({ search: (previous) => ({ ...previous, ...change(previous) }), replace: true });
    },
    [navigate],
  );

  const publishQuery = useDebouncedCallback((value: string) => {
    apply(() => ({ q: value.trim() === '' ? undefined : value }));
  }, TYPING_PAUSE_MS);

  const setQuery = useCallback(
    (value: string): void => {
      setTyped(value);
      publishQuery(value);
    },
    [publishQuery],
  );

  const setRoles = useCallback(
    (values: readonly string[]): void => {
      apply(() => ({ role: values.filter(isRole) }));
    },
    [apply],
  );

  const removeFilter = useCallback(
    (id: string): void => {
      if (id === 'q') {
        publishQuery.cancel();
        setTyped('');
        apply(() => ({ q: undefined }));
      } else if (id.startsWith(ROLE_CHIP_PREFIX)) {
        const role = id.slice(ROLE_CHIP_PREFIX.length);

        // An id this hook did not hand out changes nothing — and writes nothing.
        if (search.role.some((value) => value === role)) {
          apply((previous) => ({ role: previous.role.filter((value) => value !== role) }));
        }
      }
    },
    [apply, publishQuery, search.role],
  );

  const reset = useCallback((): void => {
    // A keystroke still waiting for its pause would otherwise land after the reset.
    publishQuery.cancel();
    setTyped('');
    apply(() => ({ q: undefined, role: [] }));
  }, [apply, publishQuery]);

  const active = projectMemberActiveFilters(search);

  return {
    search,
    typed,
    setQuery,
    setRoles,
    removeFilter,
    reset,
    active,
    isFiltered: active.length > 0,
  };
};
