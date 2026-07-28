import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionRefresher } from '@shared/api';

import { API_BASE_URL } from './test-api.util.js';

/**
 * The one request in this client that is not made through the typed client, and
 * `shared/api/session-refresh.api.ts` says why in full: `POST /auth/refresh` is not in
 * `docs/api/openapi.yaml` yet — it arrives with EPIC-006 — and the typed client cannot address a
 * path the contract does not publish. It also must not travel through the client that carries the
 * auth middleware, or a refused refresh would trigger a refresh.
 */
const refreshed = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('exchanging the refresh cookie for an access token', () => {
  it('posts to the refresh endpoint of this installation, with credentials', async () => {
    let url: unknown;
    let init: RequestInit | undefined;
    const refresh = createSessionRefresher({
      baseUrl: API_BASE_URL,
      fetch: (input, requestInit) => {
        url = input;
        init = requestInit;
        return Promise.resolve(refreshed({ accessToken: 'fresh' }));
      },
    });

    await refresh();

    expect(url).toBe(`${API_BASE_URL}/auth/refresh`);
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
  });

  it('returns the new access token', async () => {
    const refresh = createSessionRefresher({
      baseUrl: API_BASE_URL,
      fetch: () => Promise.resolve(refreshed({ accessToken: 'fresh' })),
    });

    await expect(refresh()).resolves.toBe('fresh');
  });

  it.each([
    ['the endpoint refuses', () => Promise.resolve(refreshed({ code: 'unauthenticated' }, 401))],
    ['the answer carries no token', () => Promise.resolve(refreshed({}))],
    ['the token is not a string', () => Promise.resolve(refreshed({ accessToken: 42 }))],
    [
      'the answer is not JSON at all',
      () => Promise.resolve(new Response('<html/>', { status: 200 })),
    ],
    ['the network is gone', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('reports no session when %s', async (_case, fetchImpl) => {
    const refresh = createSessionRefresher({ baseUrl: API_BASE_URL, fetch: fetchImpl });

    await expect(refresh()).resolves.toBeNull();
  });

  /**
   * The default transport is the platform one. Asserted with a stub rather than a real request:
   * `rules/testing.mdc` §12 — no test in this repository reaches the network.
   */
  it('uses the platform transport when none is injected', async () => {
    const platformFetch = vi.fn(() => Promise.resolve(refreshed({ accessToken: 'fresh' })));
    vi.stubGlobal('fetch', platformFetch);

    await expect(createSessionRefresher({ baseUrl: API_BASE_URL })()).resolves.toBe('fresh');
    expect(platformFetch).toHaveBeenCalledTimes(1);
  });
});
