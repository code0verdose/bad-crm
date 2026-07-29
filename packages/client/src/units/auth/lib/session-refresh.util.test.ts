import { afterEach, describe, expect, it, vi } from 'vitest';

import { type SharedApi } from '@shared';

import {
  clearAccessToken,
  createSessionRefresh,
  readAccessToken,
  refreshSession,
} from '@units/auth/lib';

/**
 * One rotation at a time, for the whole tab.
 *
 * The deduplication is not an optimisation, it is the difference between staying signed in and
 * being signed out of every device. The refresh token rotates on every use, so a second exchange
 * started while the first is in flight presents a token that has just been spent — reuse detection
 * fires, the family is revoked and a legitimate user is thrown out
 * (`docs/api/openapi.yaml` → `POST /auth/refresh`).
 *
 * `shared/api/auth-middleware.util.ts` already deduplicates the refreshes *it* starts. What it
 * cannot see is the one the session bootstrap starts at load, which is exactly the moment several
 * requests fly at once with no access token yet — so the gate has to be here, where both callers
 * meet.
 */
const USER_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const session = (accessToken: string): SharedApi.RefreshedSession => ({
  status: 'authenticated',
  accessToken,
  tokenType: 'Bearer',
  expiresIn: 900,
  user: { id: USER_ID, email: 'ada@example.com', locale: 'en', timezone: 'Europe/Berlin' },
  organization: { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  clearAccessToken();
  vi.unstubAllGlobals();
});

describe('the deduplicating refresh', () => {
  it('answers who the tab is, and stores the token it was given', async () => {
    const refresh = createSessionRefresh({
      exchange: () => Promise.resolve({ kind: 'session' as const, session: session('fresh') }),
    });

    await expect(refresh()).resolves.toEqual({
      kind: 'session',
      identity: { userId: USER_ID, organizationId: ORGANIZATION_ID },
    });
    expect(readAccessToken()).toBe('fresh');
  });

  it('runs one exchange for callers that arrive together', async () => {
    const exchange = vi.fn(() =>
      Promise.resolve({ kind: 'session' as const, session: session('fresh') }),
    );
    const refresh = createSessionRefresh({ exchange });

    const [first, second] = await Promise.all([refresh(), refresh()]);

    expect(exchange).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  /**
   * The gate opens again once the answer is in: an access token expires every fifteen minutes and
   * the tab has to be able to rotate more than once in its life.
   */
  it('opens again after the exchange has answered', async () => {
    const exchange = vi.fn(() =>
      Promise.resolve({ kind: 'session' as const, session: session('fresh') }),
    );
    const refresh = createSessionRefresh({ exchange });

    await refresh();
    await refresh();

    expect(exchange).toHaveBeenCalledTimes(2);
  });

  /**
   * A `2xx` that says «authenticated» and carries ids this client cannot parse. `adoptSession`
   * refuses it and drops the token, which is right — staying signed in on a body we could not read
   * is worse than signing out.
   *
   * What it must **not** be called is a refusal. A refusal is the server ending the session, and
   * acting on it sends the tab to the login form; an unreadable body says the deployment is
   * mismatched and says nothing at all about this person's credentials. So it reports `unavailable`,
   * the state is left alone, and the next rotation can succeed against a fixed server.
   */
  it('calls an unreadable session an outage, not a refusal', async () => {
    const refresh = createSessionRefresh({
      exchange: () =>
        Promise.resolve({
          kind: 'session' as const,
          session: { ...session('fresh'), user: { ...session('fresh').user, id: 'not-a-uuid' } },
        }),
    });

    await expect(refresh()).resolves.toEqual({ kind: 'unavailable' });
    expect(readAccessToken()).toBeNull();
  });

  it('reports no session when the exchange refuses, and forgets the token', async () => {
    const refresh = createSessionRefresh({
      exchange: () => Promise.resolve({ kind: 'refused' as const }),
    });
    const first = createSessionRefresh({
      exchange: () => Promise.resolve({ kind: 'session' as const, session: session('fresh') }),
    });
    await first();

    await expect(refresh()).resolves.toEqual({ kind: 'refused' });
    expect(readAccessToken()).toBeNull();
  });

  /**
   * The instance the application uses, exercised through the transport rather than around it: this
   * is the line that would otherwise be «configured once, never executed».
   */
  it('reaches the refresh endpoint of this installation', async () => {
    const requests: Request[] = [];
    vi.stubGlobal('fetch', (request: Request) => {
      requests.push(request);

      return Promise.resolve(jsonResponse(session('fresh')));
    });

    await expect(refreshSession()).resolves.toMatchObject({ identity: { userId: USER_ID } });
    expect(requests[0]?.url).toContain('/auth/refresh');
  });
});
