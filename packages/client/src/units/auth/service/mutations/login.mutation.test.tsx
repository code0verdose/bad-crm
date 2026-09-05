import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, SharedLib } from '@shared';

/**
 * What the sign-in mutation is allowed to leave behind.
 *
 * `POST /auth/login` answers with an `AuthenticatedSession`, and the access token is part of it.
 * TanStack Query keeps whatever `mutationFn` resolves to in the `MutationCache` — five minutes by
 * default, and longer while an observer is mounted — so a `mutationFn` that returns the answer
 * unchanged has published the token into a cache. The cache is not a private corner either: the
 * `QueryClient` travels in the router context, and `@tanstack/router-core` assigns
 * `self.__TSR_ROUTER__ = this` for every router built in a document, with no development guard.
 *
 * CLAUDE.md invariant 3 names the places a credential may not be — «не в состоянии роутера, не в
 * query-кеше» among them — so the fix is at the boundary rather than at the readers: the mutation
 * function takes the answer apart, puts the token in the module variable that owns it, and resolves
 * to an outcome that cannot carry one.
 */
const USER_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const ACCESS_TOKEN = 'access-token-1';

const CREDENTIALS = { email: 'ada@example.com', password: 'correct-horse-battery' };

/**
 * A fresh attempt per case, built here rather than imported.
 *
 * `loginAttempt` hands its password over once, so a shared constant would make the second case in
 * this file send `null` and the failure would read as a bug in the mutation. Built inline because
 * the unit is re-imported per case (`freshUnit`) and the shape is structural: what the mutation
 * needs is an address and a function that answers the password, not a particular module's copy of
 * the factory.
 */
const attempt = () => {
  let secret: string | null = CREDENTIALS.password;

  return {
    email: CREDENTIALS.email,
    takePassword: () => {
      const value = secret;

      secret = null;

      return value;
    },
  };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const signedIn = (): Response =>
  json({
    status: 'authenticated',
    accessToken: ACCESS_TOKEN,
    tokenType: 'Bearer',
    expiresIn: 900,
    user: { id: USER_ID, email: 'ada@example.com', locale: 'en', timezone: 'Europe/Berlin' },
    organization: { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
  });

interface Harness {
  readonly queryClient: QueryClient;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

const harness = (): Harness => {
  const queryClient = SharedApi.createAppQueryClient({
    notify: SharedLib.silentNotifications,
    logError: vi.fn(),
  });

  return {
    queryClient,
    wrapper: function Wrapper({ children }: { readonly children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    },
  };
};

/** Everything the cache holds for every mutation it remembers, as a string an attacker would grep. */
const cacheContents = (queryClient: QueryClient): string =>
  JSON.stringify(
    queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
  );

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

describe('what a successful sign-in leaves in the mutation cache', () => {
  it('holds an identity and no access token', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(signedIn()));
    const { AuthService } = await freshUnit();
    const { queryClient, wrapper } = harness();

    const { result } = renderHook(() => AuthService.useLoginMutation(), { wrapper });
    result.current.mutate(attempt());

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual({
      status: 'authenticated',
      identity: { userId: USER_ID, organizationId: ORGANIZATION_ID },
      secondFactorExpiresAt: null,
    });
    expect(cacheContents(queryClient)).not.toContain(ACCESS_TOKEN);
  });

  /**
   * The arguments, not the answer — and they are the half that was still there.
   *
   * Stripping the token out of the result left `state.variables` untouched, and those are the address
   * and the **password**. They are reachable by the same route the assertion above defends against
   * (`self.__TSR_ROUTER__` → `queryClient`) and they outlive the form: `gcTime` is counted from the
   * moment the last observer unmounts, so the default five minutes start when the person has already
   * navigated on. A password is reusable and long-lived, which makes it worth more than the
   * fifteen-minute token this suite was already protecting.
   *
   * `gcTime: 0` is what this asserts, stated as the observable property rather than as the option:
   * nothing of the credential remains in the cache once the mutation is no longer observed.
   */
  it('keeps the password out of the cache once nothing is watching', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(signedIn()));
    const { AuthService } = await freshUnit();
    const { queryClient, wrapper } = harness();

    const { result, unmount } = renderHook(() => AuthService.useLoginMutation(), { wrapper });
    result.current.mutate(attempt());

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    unmount();

    await waitFor(() => {
      expect(cacheContents(queryClient)).not.toContain(CREDENTIALS.password);
    });
  });

  /**
   * The token is not merely absent from the cache — it is where it belongs. An implementation that
   * dropped the whole answer on the floor would pass the assertion above and sign nobody in.
   */
  it('still puts the token in memory and the session in the store', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(signedIn()));
    const { AuthLib, AuthService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => AuthService.useLoginMutation(), { wrapper });
    result.current.mutate(attempt());

    await waitFor(() => {
      expect(AuthService.authSession.read()).toEqual({
        status: 'authenticated',
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
      });
    });
    expect(AuthLib.readAccessToken()).toBe(ACCESS_TOKEN);
  });

  /**
   * The refusal on the other side of «the password can be read once».
   *
   * `loginAttempt` hands its password over one time and answers `null` after that, which makes a
   * second read a statement about the callers rather than about the network: two of them believed
   * they owned the same attempt. The mutation refuses instead of sending, because the alternative —
   * quietly re-posting a credential that was supposed to be spent — turns a wiring mistake into a
   * second transmission of a password, and hides it.
   *
   * Asserted through `fetch` rather than only through the rejection: «it failed» would also be true
   * of an implementation that sent the request and then threw.
   */
  it('refuses an attempt whose password has already been read, without sending it', async () => {
    const send = vi.fn(() => Promise.resolve(signedIn()));

    vi.stubGlobal('fetch', send);
    const { AuthService } = await freshUnit();
    const { wrapper } = harness();

    const spent = attempt();

    spent.takePassword();

    const { result } = renderHook(() => AuthService.useLoginMutation(), { wrapper });
    result.current.mutate(spent);

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('login attempt has already been spent');
    expect(send).not.toHaveBeenCalled();
  });

  /**
   * The other answer of the same operation. It carries no session, so there is nothing to hide —
   * but it decides what the form says, so the outcome has to keep the status.
   */
  it('keeps the status when the answer was a choice rather than a session', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        json({
          status: 'organization_selection_required',
          organizations: [{ id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' }],
        }),
      ),
    );
    const { AuthService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => AuthService.useLoginMutation(), { wrapper });
    result.current.mutate(attempt());

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual({
      status: 'organization_selection_required',
      identity: null,
      secondFactorExpiresAt: null,
    });
  });
});
