import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApiClient } from '@shared/api';
import {
  clearAccessToken,
  createSessionAuthMiddleware,
  onAuthEvent,
  readAccessToken,
  setAccessToken,
} from '@units/auth/lib';

/**
 * The composition itself: the transport in `shared/api` knows how to refresh and retry, this unit
 * knows where the token lives and who has to be told when the session ends. Neither knows about the
 * router, which is the point — `app/` subscribes to the bus and navigates.
 *
 * The runner is not a browser, so `Request` refuses a relative URL; the client under test is given
 * an origin while the refresher keeps the configured `/api/v1`, which the stubbed transport below
 * receives as a plain string.
 */
const API_BASE_URL = 'http://localhost/api/v1';

const unauthorized = (): Response =>
  new Response(
    JSON.stringify({
      type: 'https://bad-crm.dev/problems/unauthenticated',
      title: 'Unauthenticated',
      status: 401,
      code: 'unauthenticated',
      requestId: 'req-401',
    }),
    { status: 401, headers: { 'content-type': 'application/problem+json' } },
  );

/**
 * A rotation, as `POST /auth/refresh` publishes it: the token for the next fifteen minutes and who
 * it belongs to. Both halves matter — `adoptSession` refuses an answer whose identity it cannot
 * parse, and refusing is indistinguishable from «no session».
 */
const rotated = (accessToken: string): Response =>
  new Response(
    JSON.stringify({
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
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const meta = (): Response =>
  new Response(JSON.stringify({ apiVersion: 'v1', serverTime: '2026-07-27T09:41:12.004Z' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const clientRefusingUntilRetried = (attempts: Request[]) => {
  const client = createApiClient({
    baseUrl: API_BASE_URL,
    fetch: (request: Request) => {
      attempts.push(request);
      return Promise.resolve(attempts.length === 1 ? unauthorized() : meta());
    },
  });

  client.use(createSessionAuthMiddleware());

  return client;
};

afterEach(() => {
  clearAccessToken();
  vi.unstubAllGlobals();
});

describe('the session-bound auth middleware', () => {
  it('sends the token this unit holds', async () => {
    const attempts: Request[] = [];
    const client = createApiClient({
      baseUrl: API_BASE_URL,
      fetch: (request: Request) => {
        attempts.push(request);
        return Promise.resolve(meta());
      },
    });
    client.use(createSessionAuthMiddleware());
    setAccessToken('token-1');

    await client.GET('/meta');

    expect(attempts[0]?.headers.get('authorization')).toBe('Bearer token-1');
  });

  it('stores the rotated token and replays the request that was refused', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(rotated('rotated')));
    const attempts: Request[] = [];
    setAccessToken('expired');

    const { response } = await clientRefusingUntilRetried(attempts).GET('/meta');

    expect(response.status).toBe(200);
    expect(readAccessToken()).toBe('rotated');
    expect(attempts[1]?.headers.get('authorization')).toBe('Bearer rotated');
  });

  it('announces a failed refresh, clears the session and announces the sign-out', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 401 })));
    const events: string[] = [];
    const unsubscribe = onAuthEvent((event) => events.push(event));
    setAccessToken('expired');

    const { response } = await clientRefusingUntilRetried([]).GET('/meta');
    unsubscribe();

    expect(response.status).toBe(401);
    expect(events).toEqual(['refresh-failed', 'logged-out']);
    expect(readAccessToken()).toBeNull();
  });

  /**
   * The same 401 on the way in, a different fact on the way back — and nothing about the session is
   * announced or thrown away.
   *
   * This is the composition half of the outage case. The transport reports `unavailable`, and what
   * this unit must *not* do is the whole assertion: no `refresh-failed`, no `logged-out`, and the
   * token still in memory. Signing the tab out here was one restart of the database away.
   */
  it('says nothing about the session when the rotation could not reach the server', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 503 })));
    const events: string[] = [];
    const unsubscribe = onAuthEvent((event) => events.push(event));
    setAccessToken('expired');

    const { response } = await clientRefusingUntilRetried([]).GET('/meta');
    unsubscribe();

    expect(response.status).toBe(401);
    expect(events).toEqual([]);
    expect(readAccessToken()).toBe('expired');
  });
});
