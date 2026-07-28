import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionRefresher } from '@shared/api';

import { API_BASE_URL } from './test-api.util.js';

/**
 * The refresh call goes through the typed client like everything else — `POST /auth/refresh` is
 * published in `docs/api/openapi.yaml` (EPIC-006) — but through a *separate instance* of it, with
 * no middleware attached. `shared/api/session-refresh.api.ts` says why: a refused refresh is a 401,
 * and a 401 is what makes the auth middleware start a refresh.
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
    let sent: Request | undefined;
    const refresh = createSessionRefresher({
      baseUrl: API_BASE_URL,
      fetch: (request) => {
        sent = request;

        return Promise.resolve(refreshed({ status: 'authenticated', accessToken: 'fresh' }));
      },
    });

    await refresh();

    expect(sent?.url).toBe(`${API_BASE_URL}/auth/refresh`);
    expect(sent?.method).toBe('POST');
    expect(sent?.credentials).toBe('include');
  });

  /**
   * The refresh cookie is `HttpOnly`, so it is sent by the browser and by nothing else. Asserting
   * that the request carries no `Cookie` header is asserting that this module never tries to be
   * clever about a value it must not be able to read.
   */
  it('sends no cookie of its own — the browser holds the only copy', () => {
    let sent: Request | undefined;
    const refresh = createSessionRefresher({
      baseUrl: API_BASE_URL,
      fetch: (request) => {
        sent = request;

        return Promise.resolve(refreshed({ status: 'authenticated', accessToken: 'fresh' }));
      },
    });

    return refresh().then(() => {
      expect(sent?.headers.has('cookie')).toBe(false);
      expect(sent?.headers.has('authorization')).toBe(false);
    });
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
   * The deployed default of `VITE_API_BASE_URL` is a same-origin path, and the typed client turns a
   * call into a `Request`, which refuses one. A browser resolves it against the document; outside a
   * document nothing does, and the refresh would fail with a URL error that looks exactly like an
   * expired session — so the resolution is explicit.
   */
  it('resolves a same-origin base against the current origin', async () => {
    let sent: Request | undefined;
    const refresh = createSessionRefresher({
      baseUrl: '/api/v1',
      fetch: (request) => {
        sent = request;

        return Promise.resolve(refreshed({ status: 'authenticated', accessToken: 'fresh' }));
      },
    });

    await expect(refresh()).resolves.toBe('fresh');
    expect(sent?.url).toBe(`${globalThis.location.origin}/api/v1/auth/refresh`);
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
