import { useDebouncedValue, useLocalStorage } from '@mantine/hooks';
import { useState } from 'react';
import { useStore } from 'zustand';

import { type ProjectOption } from '@units/project/api';
import {
  inRecencyOrder,
  mergeRecentProjects,
  projectSwitchTarget,
  type ProjectSwitchTarget,
} from '@units/project/lib/utils/index.js';
import { type ProjectSection } from '@units/project/model/constants/project-sections.constant.js';
import {
  useCurrentProjectQuery,
  useProjectOptionsQuery,
} from '@units/project/service/queries/project-options.query.js';
import {
  RECENT_PROJECTS_STORAGE_KEY,
  recentProjects,
  type RecentProjectsStore,
} from '@units/project/service/stores/recent-projects.store.js';

/**
 * The pause before a keystroke becomes a request — the directory's 300 ms (STORY-014-06,
 * acceptance 3). Debounced as a **value** here, not as a URL write: the search text of a closed-on-
 * select combobox is not screen state and does not belong in the address bar.
 */
export const SWITCHER_TYPING_PAUSE_MS = 300;

export interface ProjectSwitcherInput {
  /** The project in the path, or `null` outside `/projects/$projectId/**`. */
  readonly currentProjectId: string | null;
  /** The section in the path, or `null` outside a project. */
  readonly section: ProjectSection | null;
  /**
   * Performs the navigation. Passed in so the unit never reaches into the route tree above it —
   * the same seam `useProjectFilters` takes.
   */
  readonly onSwitch: (target: ProjectSwitchTarget) => void;
  /** The tab's recent list by default; a test brings its own. */
  readonly recentStore?: RecentProjectsStore;
}

export interface ProjectSwitcher {
  /** The project the trigger names, once its card is in the cache. */
  readonly current: ProjectOption | null;
  readonly isOpen: boolean;
  readonly open: () => void;
  readonly close: () => void;
  /** What the search field shows — runs ahead of the request while somebody types. */
  readonly typed: string;
  readonly setTyped: (value: string) => void;
  readonly archived: boolean;
  readonly setArchived: (value: boolean) => void;
  /** Pinned above the results, most recent first — only while nothing is typed. */
  readonly recent: readonly ProjectOption[];
  /** The rest — or, with text typed, everything that matches. */
  readonly results: readonly ProjectOption[];
  readonly hasMore: boolean;
  readonly status: 'pending' | 'error' | 'success';
  readonly retry: () => void;
  /**
   * Takes the person to `projectId`, in the same section they are in now. `true` when the choice
   * leads to another project — the page it opens owns focus from then on; `false` for the project
   * already open, which goes nowhere.
   */
  readonly select: (projectId: string) => boolean;
}

const toOption = (card: {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly status: ProjectOption['status'];
  readonly color: string;
}): ProjectOption => ({
  id: card.id,
  key: card.key,
  name: card.name,
  status: card.status,
  color: card.color,
});

/**
 * The header's project switcher — STORY-014-06, the client's logic in one place.
 *
 * **Nothing about the current project is stored.** Which project is current is the path, read by
 * the caller and passed in (acceptance 1); what the trigger says about it is the card the layout's
 * guard already cached. Switching is a navigation to the same section of the other project
 * (`projectSwitchTarget`, acceptance 2), and the guard of that route is what remembers the visit.
 *
 * **The server decides what may be offered.** Results and the recent group both come from
 * `GET /projects/options`: the remembered ids are sent, and only those the caller can still open
 * come back — a lost project drops out of «recent» without anything here deciding it (acceptance 5).
 * Nothing is asked until the switcher is opened.
 */
export const useProjectSwitcher = ({
  currentProjectId,
  section,
  onSwitch,
  recentStore = recentProjects,
}: ProjectSwitcherInput): ProjectSwitcher => {
  const [isOpen, setIsOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [archived, setArchived] = useState(false);
  const [search] = useDebouncedValue(typed.trim(), SWITCHER_TYPING_PAUSE_MS);
  const visited = useStore(recentStore, (state) => state.visited);
  const forgotten = useStore(recentStore, (state) => state.forgotten);
  // Read synchronously on mount (`getInitialValueInEffect: false`), so the first open already asks
  // about what the browser remembered. `unknown`: storage is outside the program and is sanitized.
  const [remembered, setRemembered] = useLocalStorage<unknown>({
    key: RECENT_PROJECTS_STORAGE_KEY,
    defaultValue: [],
    getInitialValueInEffect: false,
  });
  const recentIds = mergeRecentProjects(visited, remembered, forgotten);

  const optionsQ = useProjectOptionsQuery({ q: search, archived, recent: recentIds }, isOpen);
  const currentQ = useCurrentProjectQuery(currentProjectId);

  const answer = optionsQ.data;
  // While typing, the pinned group gives way to the matches: it would push them out of sight.
  const recent =
    typed.trim() === '' && answer !== undefined ? inRecencyOrder(answer.recent, recentIds) : [];
  const pinned = new Set(recent.map((option) => option.id));

  const close = (): void => {
    setIsOpen(false);
    setTyped('');
  };

  return {
    current: currentQ.data === undefined ? null : toOption(currentQ.data),
    isOpen,
    // Opening is the moment the list is written back: an event, so no effect is needed to keep
    // the browser's copy in step with this tab's visits.
    open: () => {
      setIsOpen(true);
      setRemembered(recentIds);
    },
    close,
    typed,
    setTyped,
    archived,
    setArchived,
    recent,
    results: (answer?.items ?? []).filter((option) => !pinned.has(option.id)),
    hasMore: answer?.hasMore ?? false,
    status: optionsQ.status,
    retry: () => {
      void optionsQ.refetch();
    },
    select: (projectId) => {
      close();
      if (projectId === currentProjectId) return false;
      onSwitch(projectSwitchTarget(projectId, section));

      return true;
    },
  };
};
