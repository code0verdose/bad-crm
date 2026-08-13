import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi } from '@shared';

/**
 * The second half of a sign-in: one code, and the session it buys.
 *
 * Two properties are asserted here that nothing else in the tree can assert.
 *
 * **The intermediate token is attached by the mutation, not by the caller.** It never appears in a
 * form value, in a mutation variable, in the URL or in Web Storage — it is read from the module
 * that holds it (`lib/mfa-token-storage.util.ts`) at the moment the request is built. So the cache
 * that outlives the screen holds the typed code and nothing else, and the credential has exactly
 * one home.
 *
 * **A refused code is one signal, and it is the one beside the field.** `rules/errors-and-toasts.mdc`
 * §4 puts a server's verdict on a field under that field; the local `onError` is what stops the
 * global `MutationCache.onError` adding a toast on top of it (§2–§3).
 */
const USER_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const ACCESS_TOKEN = 'access-token-after-2fa';
const MFA_TOKEN = 'mfa-token-abcdef';

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

const refused = (code: string): Response =>
  json(
    {
      type: `https://bad-crm.dev/problems/${code}`,
      title: 'Second factor refused',
      status: 401,
      code,
      requestId: 'req-2fa',
    },
    401,
  );

interface Harness {
  readonly queryClient: QueryClient;
  readonly notify: ReturnType<typeof notifications>;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

/** A spy over the port the query client shouts through, so «no toast» is observable. */
const notifications = () => ({ success: vi.fn(), error: vi.fn() });

const harness = (): Harness => {
  const notify = notifications();
  const queryClient = SharedApi.createAppQueryClient({ notify, logError: vi.fn() });

  return {
    queryClient,
    notify,
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

/**
 * The unit **and** the shared layer it threw the error from, out of the same fresh module graph.
 *
 * `errorMessageKey` recognises a failure by `instanceof ApiError`, and `vi.resetModules()` builds a
 * second `ApiError` class — so asking the outer graph about an error minted in the inner one
 * answers «not one of mine» and maps every refusal to `internal_error`. Which is exactly what this
 * suite saw before the two were taken from the same import.
 */
const freshUnit = async () => {
  vi.resetModules();

  const [auth, shared] = await Promise.all([import('@units/auth'), import('@shared')]);

  return { ...auth, SharedApi: shared.SharedApi };
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('presenting the second factor', () => {
  it('sends the code with the token the password step left in memory', async () => {
    const bodies: unknown[] = [];

    vi.stubGlobal('fetch', async (request: Request) => {
      bodies.push(await request.clone().json());

      return signedIn();
    });

    const { AuthLib, AuthService } = await freshUnit();
    AuthLib.setMfaToken(MFA_TOKEN);

    const { result } = renderHook(() => AuthService.useVerifySecondFactorMutation(), {
      wrapper: harness().wrapper,
    });
    result.current.mutate({ code: '123456' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(bodies).toEqual([{ mfaToken: MFA_TOKEN, code: '123456' }]);
  });

  it('signs the tab in: token in memory, session in the store, one announcement', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(signedIn()));
    const { AuthLib, AuthService } = await freshUnit();
    AuthLib.setMfaToken(MFA_TOKEN);
    const events: string[] = [];
    const unsubscribe = AuthLib.onAuthEvent((event) => events.push(event));

    const { result } = renderHook(() => AuthService.useVerifySecondFactorMutation(), {
      wrapper: harness().wrapper,
    });
    result.current.mutate({ code: '123456' });

    await waitFor(() => {
      expect(AuthService.authSession.read()).toEqual({
        status: 'authenticated',
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
      });
    });
    unsubscribe();
    expect(AuthLib.readAccessToken()).toBe(ACCESS_TOKEN);
    expect(events).toEqual(['logged-in']);
  });

  /**
   * The token is spent by the server in the same step, so keeping the copy would be keeping a dead
   * credential — and a live one for the seconds before the answer arrives. Asserted as «reading it
   * throws», which is the only observable this module offers.
   */
  it('forgets the intermediate token once it has been spent', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(signedIn()));
    const { AuthLib, AuthService } = await freshUnit();
    AuthLib.setMfaToken(MFA_TOKEN);

    const { result } = renderHook(() => AuthService.useVerifySecondFactorMutation(), {
      wrapper: harness().wrapper,
    });
    result.current.mutate({ code: '123456' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(() => AuthLib.readMfaToken()).toThrow(/no second factor/i);
  });

  /**
   * The invariant of the story, asserted where it would break: neither credential ends up in the
   * cache the router carries. The access token is stripped by `adoptSession`; the intermediate
   * token was never a variable of this mutation to begin with.
   */
  it('leaves neither the intermediate token nor the access token in the mutation cache', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(signedIn()));
    const { AuthLib, AuthService } = await freshUnit();
    AuthLib.setMfaToken(MFA_TOKEN);
    const { queryClient, wrapper } = harness();

    const { result } = renderHook(() => AuthService.useVerifySecondFactorMutation(), { wrapper });
    result.current.mutate({ code: '123456' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(cacheContents(queryClient)).not.toContain(MFA_TOKEN);
    expect(cacheContents(queryClient)).not.toContain(ACCESS_TOKEN);
  });

  it('leaves the tab signed out when the code is refused, and says so without a toast', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(refused('mfa_invalid_code')));
    const { AuthLib, AuthService, SharedApi: FreshApi } = await freshUnit();
    AuthLib.setMfaToken(MFA_TOKEN);
    const events: string[] = [];
    const unsubscribe = AuthLib.onAuthEvent((event) => events.push(event));
    const { notify, wrapper } = harness();

    const { result } = renderHook(() => AuthService.useVerifySecondFactorMutation(), { wrapper });
    result.current.mutate({ code: '000000' });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    unsubscribe();
    expect(AuthService.authSession.read()).toEqual({ status: 'unknown' });
    expect(AuthLib.readAccessToken()).toBeNull();
    expect(events).toEqual([]);
    expect(notify.error).not.toHaveBeenCalled();
    expect(FreshApi.errorMessageKey(result.current.error)).toBe('errors.code.mfa_invalid_code');
  });

  /**
   * A refusal does not throw the step away: the token survives up to five wrong codes, and asking
   * for the password again after a typo would be the screen forgetting what it is in the middle of.
   */
  it('keeps the intermediate token after a refusal, so the next attempt has one', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(refused('mfa_invalid_code')));
    const { AuthLib, AuthService } = await freshUnit();
    AuthLib.setMfaToken(MFA_TOKEN);

    const { result } = renderHook(() => AuthService.useVerifySecondFactorMutation(), {
      wrapper: harness().wrapper,
    });
    result.current.mutate({ code: '000000' });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(AuthLib.readMfaToken()).toBe(MFA_TOKEN);
  });

  /**
   * A 200 carrying ids this client cannot read is not a session — the same refusal `adoptSession`
   * makes on the password step, reached by the other door.
   */
  it('does not sign in on an answer whose identity it cannot parse', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        json({
          status: 'authenticated',
          accessToken: ACCESS_TOKEN,
          tokenType: 'Bearer',
          expiresIn: 900,
          user: {
            id: 'not-a-uuid',
            email: 'ada@example.com',
            locale: 'en',
            timezone: 'Europe/Berlin',
          },
          organization: { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
        }),
      ),
    );
    const { AuthLib, AuthService } = await freshUnit();
    AuthLib.setMfaToken(MFA_TOKEN);
    const events: string[] = [];
    const unsubscribe = AuthLib.onAuthEvent((event) => events.push(event));

    const { result } = renderHook(() => AuthService.useVerifySecondFactorMutation(), {
      wrapper: harness().wrapper,
    });
    result.current.mutate({ code: '123456' });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });
    unsubscribe();
    expect(AuthService.authSession.read()).toEqual({ status: 'unknown' });
    expect(AuthLib.readAccessToken()).toBeNull();
    expect(events).toEqual([]);
  });
});
