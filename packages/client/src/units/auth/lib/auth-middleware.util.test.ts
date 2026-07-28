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
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ accessToken: 'rotated' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
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
});
