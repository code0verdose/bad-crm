import { createStore, type StoreApi } from 'zustand/vanilla';

import {
  withRecentProject,
  withoutRecentProject,
} from '@units/project/lib/utils/recent-projects.util.js';

/** Versioned by name, so a later shape is a new key. */
const RECENT_PROJECTS_STORAGE_KEY = 'bc.recent-projects.v1';

/**
 * The key the switcher keeps one person's remembered ids under in the browser (`useProjectSwitcher`,
 * through Mantine's `useLocalStorage`). **Per person**, because a browser is shared by whoever signs
 * in on it: under one key for all, the next person's switcher would send the previous person's
 * projects as its own «recent». The list is also removed when the session ends.
 */
export const recentProjectsStorageKey = (userId: string): string =>
  `${RECENT_PROJECTS_STORAGE_KEY}:${userId}`;

/**
 * What this tab has learnt since it opened: the projects it entered, most recent first, and the ones
 * the server answered «not found» for. No names, keys or colours — those are the server's.
 */
export interface RecentProjectsState {
  readonly visited: readonly string[];
  readonly forgotten: readonly string[];
}

export interface RecentProjectsStore extends StoreApi<RecentProjectsState> {
  /** A project was opened — the layout's guard let it through. */
  readonly remember: (projectId: string) => void;
  /** A project was answered «not found» — it is not pinned again (STORY-014-06, acceptance 5). */
  readonly forget: (projectId: string) => void;
  /** The session ended — nothing of this person's visits is left for the next one in the tab. */
  readonly reset: () => void;
}

/**
 * The visits of this tab, as the project layout's guard reports them (STORY-014-06, acceptance 3).
 *
 * **A store because a guard writes it.** `beforeLoad` runs outside React, and the switcher in the
 * header reads what it wrote — cross-screen state read outside a render, the row of
 * `rules/frontend-fsd.mdc` §16 that zustand is for.
 *
 * **In memory, not persisted here.** Surviving a reload is the switcher's job, through Mantine's
 * `useLocalStorage` — the one sanctioned door to Web Storage in this client (the architecture test
 * `data-layer-conventions.test.ts` keeps every other one shut, because that is how «no credential in
 * Web Storage» is enforced). The switcher merges this tab's visits in front of what the browser
 * remembers and writes the result back when it is opened; a guard cannot call a hook, so it does
 * not write storage at all.
 *
 * A project forgotten here is taken out of the remembered list too, and even without it the server
 * answers only the ids the caller can still open — «recent» cannot resurrect a lost project.
 */
export const createRecentProjectsStore = (): RecentProjectsStore => {
  const store = createStore<RecentProjectsState>(() => ({ visited: [], forgotten: [] }));

  return {
    ...store,
    remember: (projectId) => {
      const { visited, forgotten } = store.getState();

      store.setState({
        visited: withRecentProject(visited, projectId),
        forgotten: withoutRecentProject(forgotten, projectId),
      });
    },
    forget: (projectId) => {
      const { visited, forgotten } = store.getState();

      store.setState({
        visited: withoutRecentProject(visited, projectId),
        forgotten: [...withoutRecentProject(forgotten, projectId), projectId],
      });
    },
    reset: () => {
      store.setState({ visited: [], forgotten: [] });
    },
  };
};

/** This tab's visits. The factory above is what gives a test a store of its own. */
export const recentProjects = createRecentProjectsStore();
