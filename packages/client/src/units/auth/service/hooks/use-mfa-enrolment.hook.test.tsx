import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi } from '@shared';

/**
 * What happens after the ten codes are saved — the half of the forced enrolment that is not a
 * screen (STORY-013-05, acceptance 3).
 *
 * `test/routes/mfa-enrolment-flow.test.tsx` proves the happy path end to end, through the real
 * router: pair, save, and be in the application. What it cannot reach are the two rotations that do
 * not produce a session, and they are the ones worth pinning — the difference between «the server
 * says this tab is signed out» and «the server did not answer» is a difference the store already
 * makes for its own bootstrap, and getting it wrong here would either strand somebody on a wizard
 * they have finished or sign them out because a proxy hiccuped.
 *
 * The rotation is stubbed at the transport, not at `refreshSession`: the module holds one in-flight
 * promise for the whole tab, and a doubled seam would prove nothing about the object the application
 * actually calls.
 */
const USER_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const session = (): Response =>
  new Response(
    JSON.stringify({
      status: 'authenticated',
      accessToken: 'access-token-2',
      tokenType: 'Bearer',
      expiresIn: 900,
      user: { id: USER_ID, email: 'ada@example.com', locale: 'en', timezone: 'Europe/Berlin' },
      organization: { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

interface Harness {
  readonly queryClient: QueryClient;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

const harness = (): Harness => {
  const queryClient = SharedApi.createAppQueryClient({
    notify: { error: vi.fn(), success: vi.fn() },
    logError: vi.fn(),
  });

  return {
    queryClient,
    wrapper: function Wrapper({ children }: { readonly children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    },
  };
};

/** A unit whose session store and refresh gate are this case's, not the previous one's. */
const freshUnit = async () => {
  vi.resetModules();

  return await import('@units/auth');
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('finishing a forced enrolment', () => {
  it('rotates the session and announces it, so the guards are asked again', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(session()));

    const { AuthService, AuthLib } = await freshUnit();
    const events: string[] = [];
    const unsubscribe = AuthLib.onAuthEvent((event) => events.push(event));

    const { wrapper } = harness();
    const { result } = renderHook(() => AuthService.useMfaEnrolment(), { wrapper });

    act(() => {
      result.current.finish();
    });

    await waitFor(() => {
      expect(events).toEqual(['logged-in']);
    });

    // Set before the rotation was even started, and it has to be: the codes are dropped in the same
    // synchronous step, so without it the wizard would fall back to offering an enrolment that has
    // already happened.
    expect(result.current.isEnrolled).toBe(true);

    // The point of the rotation: the store now holds an identity with no enrolment scope, which is
    // what `requireEnrolment` reads when the invalidation runs.
    expect(AuthService.authSession.read()).toMatchObject({
      status: 'authenticated',
      userId: USER_ID,
    });
    expect(AuthService.authSession.read()).not.toHaveProperty('mfaEnrollment');

    unsubscribe();
  });

  /**
   * A refused rotation means the refresh family is gone — the person is signed out, and saying so is
   * what carries them to the sign-in screen instead of leaving them on a wizard whose two endpoints
   * now answer 401.
   */
  it('reports a refused rotation as the end of the session', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 401 })));

    const { AuthService, AuthLib } = await freshUnit();
    const events: string[] = [];
    const unsubscribe = AuthLib.onAuthEvent((event) => events.push(event));

    const { wrapper } = harness();
    const { result } = renderHook(() => AuthService.useMfaEnrolment(), { wrapper });

    act(() => {
      result.current.finish();
    });

    await waitFor(() => {
      expect(events).toEqual(['logged-out']);
    });

    unsubscribe();
  });

  /**
   * A rotation that never reached the server says nothing about the session, so nothing is
   * announced and nothing is ended — the same answer `auth-session.store.ts` gives its own
   * bootstrap, and for the same reason: «unreachable» and «signed out» are different facts.
   */
  it('says nothing when the rotation never reached the server', async () => {
    const attempts: string[] = [];

    vi.stubGlobal('fetch', (request: Request) => {
      attempts.push(new URL(request.url).pathname);

      return Promise.reject(new TypeError('Failed to fetch'));
    });

    const { AuthService, AuthLib } = await freshUnit();
    const events: string[] = [];
    const unsubscribe = AuthLib.onAuthEvent((event) => events.push(event));

    const { wrapper } = harness();
    const { result } = renderHook(() => AuthService.useMfaEnrolment(), { wrapper });

    act(() => {
      result.current.finish();
    });

    // Waited on the **request**, not on the codes: those are dropped synchronously now, so a wait on
    // them would be over before the rotation had answered and «nothing happened» would be
    // indistinguishable from «not yet». Two microtask turns after the transport has been reached is
    // where the handler would have run had there been anything for it to do.
    await waitFor(() => {
      expect(attempts).toHaveLength(1);
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual([]);
    expect(AuthService.authSession.read().status).not.toBe('anonymous');

    unsubscribe();
  });
});
