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

/** A rotation as the contract publishes it: the token, and who it belongs to. */
const session = (accessToken: string) => ({
  status: 'authenticated',
  accessToken,
  tokenType: 'Bearer',
  expiresIn: 900,
  user: {
    id: 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e',
    email: 'ada@example.com',
    locale: 'en',
    timezone: 'Europe/Berlin',
  },
  organization: {
    id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    name: 'Bad Company',
    slug: 'bad-company',
  },
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

        return Promise.resolve(refreshed(session('fresh')));
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

        return Promise.resolve(refreshed(session('fresh')));
      },
    });

    return refresh().then(() => {
      expect(sent?.headers.has('cookie')).toBe(false);
      expect(sent?.headers.has('authorization')).toBe(false);
    });
  });

  /**
   * The whole session, not only the token: a reloaded tab learns *who* it is from this same answer,
   * and asking a second endpoint for something the first one already carried would be a second
   * round trip on every start-up. Taking it apart is `units/auth`'s job.
   */
  it('returns the session the rotation issued', async () => {
    const refresh = createSessionRefresher({
      baseUrl: API_BASE_URL,
      fetch: () => Promise.resolve(refreshed(session('fresh'))),
    });

    await expect(refresh()).resolves.toMatchObject({
      kind: 'session',
      session: { accessToken: 'fresh', user: { id: 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e' } },
    });
  });

  /**
   * Only the server saying so ends a session.
   *
   * This table used to be one case — every failure resolved to `null`, and the reasoning written
   * here was that "refused", "unparsable" and "offline" mean the same thing to the caller. They do
   * not, and the server was changed in this very epic on exactly that ground: an infrastructure
   * failure answers `5xx` instead of `401` precisely so that thirty seconds of an unreachable
   * database would stop signing everybody out. Collapsing the distinction here threw that away one
   * layer higher — `docker compose up -d` from the upgrade runbook restarts Postgres, every open tab
   * that happens to rotate in that window is told its session is gone, and people re-enter passwords
   * while a valid refresh cookie sits in the browser.
   *
   * `401` is the only refusal: it is the answer that means the presented cookie will never work
   * again. Everything else — `5xx`, a dropped connection, a body that is not the shape the contract
   * promises — is `unavailable`, which says «ask again later» and leaves the session state alone.
   * The direction of the default matters: guessing `unavailable` on a session that really is over
   * costs one failed request, while guessing `refused` on a blip costs every open tab.
   */
  it('reports a refusal only when the endpoint refuses', async () => {
    const refresh = createSessionRefresher({
      baseUrl: API_BASE_URL,
      fetch: () => Promise.resolve(refreshed({ code: 'unauthenticated' }, 401)),
    });

    await expect(refresh()).resolves.toEqual({ kind: 'refused' });
  });

  it.each([
    ['the answer carries no token', () => Promise.resolve(refreshed({}))],
    ['the token is not a string', () => Promise.resolve(refreshed({ accessToken: 42 }))],
    [
      'the answer is not JSON at all',
      () => Promise.resolve(new Response('<html/>', { status: 200 })),
    ],
    ['the network is gone', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['the database is down', () => Promise.resolve(refreshed({ code: 'internal' }, 500))],
    ['the service is restarting', () => Promise.resolve(refreshed({ code: 'unavailable' }, 503))],
    ['the gateway is not up yet', () => Promise.resolve(refreshed({}, 502))],
  ])('reports the session as unavailable, not gone, when %s', async (_case, fetchImpl) => {
    const refresh = createSessionRefresher({ baseUrl: API_BASE_URL, fetch: fetchImpl });

    await expect(refresh()).resolves.toEqual({ kind: 'unavailable' });
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

        return Promise.resolve(refreshed(session('fresh')));
      },
    });

    await expect(refresh()).resolves.toMatchObject({
      kind: 'session',
      session: { accessToken: 'fresh' },
    });
    expect(sent?.url).toBe(`${globalThis.location.origin}/api/v1/auth/refresh`);
  });

  /**
   * The default transport is the platform one. Asserted with a stub rather than a real request:
   * `rules/testing.mdc` §12 — no test in this repository reaches the network.
   */
  it('uses the platform transport when none is injected', async () => {
    const platformFetch = vi.fn(() => Promise.resolve(refreshed(session('fresh'))));
    vi.stubGlobal('fetch', platformFetch);

    await expect(createSessionRefresher({ baseUrl: API_BASE_URL })()).resolves.toMatchObject({
      kind: 'session',
      session: { accessToken: 'fresh' },
    });
    expect(platformFetch).toHaveBeenCalledTimes(1);
  });
});
