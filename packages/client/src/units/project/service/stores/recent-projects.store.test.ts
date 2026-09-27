import { describe, expect, it } from 'vitest';

import { createRecentProjectsStore, recentProjectsStorageKey } from './recent-projects.store.js';

const id = (n: number): string => `018f4a3b-0000-7000-8000-${n.toString().padStart(12, '0')}`;

describe('the recent projects store', () => {
  it('remembers a visit at the front, once', () => {
    const store = createRecentProjectsStore();

    store.remember(id(1));
    store.remember(id(2));
    store.remember(id(1));

    expect(store.getState()).toEqual({ visited: [id(1), id(2)], forgotten: [] });
  });

  it('forgets a project answered «not found», and says so for the remembered list', () => {
    const store = createRecentProjectsStore();

    store.remember(id(1));
    store.remember(id(2));
    store.forget(id(1));
    store.forget(id(1));

    expect(store.getState()).toEqual({ visited: [id(2)], forgotten: [id(1)] });
  });

  it('forgets everything on reset — a sign-out leaves nothing for the next person in the tab', () => {
    const store = createRecentProjectsStore();

    store.remember(id(1));
    store.forget(id(2));
    store.reset();

    expect(store.getState()).toEqual({ visited: [], forgotten: [] });
  });

  it('keeps each person’s remembered list under a key of their own', () => {
    expect(recentProjectsStorageKey(id(7))).toBe(`bc.recent-projects.v1:${id(7)}`);
    expect(recentProjectsStorageKey(id(7))).not.toBe(recentProjectsStorageKey(id(8)));
  });

  it('a project opened again after being forgotten is no longer forgotten', () => {
    const store = createRecentProjectsStore();

    store.forget(id(1));
    store.remember(id(1));

    expect(store.getState()).toEqual({ visited: [id(1)], forgotten: [] });
  });
});
