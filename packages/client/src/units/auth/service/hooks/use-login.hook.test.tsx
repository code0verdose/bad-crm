import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, SharedLib } from '@shared';

/**
 * Signing in, from the form's point of view: credentials go out, a session comes back, and the rest
 * of the application is told once.
 *
 * The unit is re-imported per case for the same reason the bootstrap test does it — the session
 * store is one per tab by design, and a case that signed in would otherwise hand the next case a
 * session it never created.
 */
const USER_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const CREDENTIALS = { email: 'ada@example.com', password: 'correct-horse-battery' };

/** Only ever read back as part of a body; the assertions are about the ids, not the address. */
const EMAIL_UNUSED = 'ada@example.com';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const signedIn = (): Response =>
  json({
    status: 'authenticated',
    accessToken: 'access-token-1',
    tokenType: 'Bearer',
    expiresIn: 900,
    user: { id: USER_ID, email: 'ada@example.com', locale: 'en', timezone: 'Europe/Berlin' },
    organization: { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
  });

const refused = (): Response =>
  json(
    {
      type: 'https://bad-crm.dev/problems/invalid-credentials',
      title: 'Invalid credentials',
      status: 401,
      code: 'invalid_credentials',
      requestId: 'req-1',
    },
    401,
  );

const wrapper = () => {
  const queryClient = SharedApi.createAppQueryClient({
    notify: SharedLib.silentNotifications,
    logError: vi.fn(),
  });

  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
};

const freshUnit = async () => {
  vi.resetModules();

  return import('@units/auth');
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('signing in', () => {
  it('records the session and announces it, so the guards can be re-checked', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(signedIn()));
    const { AuthLib, AuthService } = await freshUnit();
    const events: string[] = [];
    const unsubscribe = AuthLib.onAuthEvent((event) => events.push(event));

    const { result } = renderHook(() => AuthService.useLogin(), { wrapper: wrapper() });
    result.current.submit(CREDENTIALS);

    await waitFor(() => {
      expect(AuthService.authSession.read()).toEqual({
        status: 'authenticated',
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
      });
    });
    unsubscribe();
    expect(events).toEqual(['logged-in']);
  });

  it('holds the access token in memory, where a sign-in is the only thing that puts it', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(signedIn()));
    const { AuthLib, AuthService } = await freshUnit();

    const { result } = renderHook(() => AuthService.useLogin(), { wrapper: wrapper() });
    result.current.submit(CREDENTIALS);

    await waitFor(() => {
      expect(AuthLib.readAccessToken()).toBe('access-token-1');
    });
  });

  /** A transport that never answers, so «in flight» is observable rather than a race with the stub. */
  it('reports the request in flight, so the button can carry the wait', async () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined));
    const { AuthService } = await freshUnit();

    const { result } = renderHook(() => AuthService.useLogin(), { wrapper: wrapper() });
    expect(result.current.isPending).toBe(false);
    result.current.submit(CREDENTIALS);

    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });
  });

  /**
   * A refused sign-in leaves the tab exactly as anonymous as it was. The failure itself is reported
   * once, by the global `MutationCache.onError` this hook deliberately does not override
   * (`rules/errors-and-toasts.mdc` §3) — a second signal here would be the duplicate the rule
   * exists to prevent.
   */
  it('leaves the tab signed out when the credentials are refused', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(refused()));
    const { AuthLib, AuthService } = await freshUnit();
    const events: string[] = [];
    const unsubscribe = AuthLib.onAuthEvent((event) => events.push(event));

    const { result } = renderHook(() => AuthService.useLogin(), { wrapper: wrapper() });
    result.current.submit(CREDENTIALS);

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });
    unsubscribe();
    expect(AuthService.authSession.read()).toEqual({ status: 'unknown' });
    expect(AuthLib.readAccessToken()).toBeNull();
    expect(events).toEqual([]);
  });

  /**
   * A 200 that says «authenticated» and carries ids this client cannot read is not a session.
   * Signing in on it would put a branded `UserId` that is not one into every later request, and the
   * failure would surface far from here — so `adoptSession` refuses, and the tab stays as it was.
   */
  it('does not sign in on an answer whose identity it cannot parse', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        json({
          status: 'authenticated',
          accessToken: 'access-token-1',
          tokenType: 'Bearer',
          expiresIn: 900,
          user: { id: 'not-a-uuid', email: EMAIL_UNUSED, locale: 'en', timezone: 'Europe/Berlin' },
          organization: { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
        }),
      ),
    );
    const { AuthLib, AuthService } = await freshUnit();
    const events: string[] = [];
    const unsubscribe = AuthLib.onAuthEvent((event) => events.push(event));

    const { result } = renderHook(() => AuthService.useLogin(), { wrapper: wrapper() });
    result.current.submit(CREDENTIALS);

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });
    unsubscribe();
    expect(AuthService.authSession.read()).toEqual({ status: 'unknown' });
    expect(AuthLib.readAccessToken()).toBeNull();
    expect(events).toEqual([]);
  });

  /**
   * An address used in two organizations gets a choice instead of a session. The picker is
   * STORY-006-01's; what must not happen here is signing in on an answer that carries no session —
   * the form says so, inline, and the tab stays anonymous.
   */
  it('asks for an organization instead of signing in when the answer carries no session', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        json({
          status: 'organization_selection_required',
          organizations: [
            { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
            { id: USER_ID, name: 'Side Project', slug: 'side-project' },
          ],
        }),
      ),
    );
    const { AuthModel, AuthService } = await freshUnit();

    const { result } = renderHook(() => AuthService.useLogin(), { wrapper: wrapper() });
    result.current.submit(CREDENTIALS);

    await waitFor(() => {
      expect(result.current.noticeKey).toBe(AuthModel.ORGANIZATION_SELECTION_NOTICE_KEY);
    });
    expect(AuthService.authSession.read()).toEqual({ status: 'unknown' });
  });
});
