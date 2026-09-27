import { describe, expect, it } from 'vitest';

import { createRecentProjectsStore } from './recent-projects.store.js';

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

  it('a project opened again after being forgotten is no longer forgotten', () => {
    const store = createRecentProjectsStore();

    store.forget(id(1));
    store.remember(id(1));

    expect(store.getState()).toEqual({ visited: [id(1)], forgotten: [] });
  });
});
