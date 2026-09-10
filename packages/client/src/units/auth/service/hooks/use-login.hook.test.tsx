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

const MFA_TOKEN = 'mfa-token-abcdef';

/** The password was right and the account has a second factor: no session, one intermediate token. */
const secondFactorRequired = (expiresIn = 300): Response =>
  json({ status: 'mfa_required', mfaToken: MFA_TOKEN, expiresIn });

const secondFactorRefused = (code: string): Response =>
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

/**
 * One transport for both steps, answering by path — the screen makes two different requests and a
 * stub that answered the same thing to both would prove nothing about the order they happen in.
 */
const twoStepTransport = (verifyAnswer: () => Response, loginAnswer = secondFactorRequired) => {
  const requests: string[] = [];

  return {
    requests,
    fetch: (request: Request): Promise<Response> => {
      const isVerify = request.url.includes('/2fa/verify');

      requests.push(isVerify ? 'verify' : 'login');

      return Promise.resolve(isVerify ? verifyAnswer() : loginAnswer());
    },
  };
};

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
      expect(result.current.notice).toEqual({ key: AuthModel.ORGANIZATION_SELECTION_NOTICE_KEY });
    });
    expect(AuthService.authSession.read()).toEqual({ status: 'unknown' });
  });
});

/**
 * The second step, from the screen's point of view: the password step hands over an intermediate
 * token, the code buys the session, and the step ends — one way or another — rather than sitting on
 * a token that is already dead.
 *
 * The shared layer is re-imported out of the same fresh graph as the unit, because `errorMessage`
 * recognises a failure by `instanceof ApiError` and `vi.resetModules()` builds a second class.
 */
const freshUnitAndShared = async () => {
  vi.resetModules();

  const [auth, shared] = await Promise.all([import('@units/auth'), import('@shared')]);

  return { ...auth, FreshApi: shared.SharedApi };
};

describe('signing in with a second factor', () => {
  it('moves to the second step instead of signing the tab in', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(secondFactorRequired()));
    const { AuthLib, AuthService } = await freshUnit();
    const events: string[] = [];
    const unsubscribe = AuthLib.onAuthEvent((event) => events.push(event));

    const { result } = renderHook(() => AuthService.useLogin(), { wrapper: wrapper() });
    result.current.submit(CREDENTIALS);

    await waitFor(() => {
      expect(result.current.step).toBe('second-factor');
    });
    unsubscribe();
    expect(AuthService.authSession.read()).toEqual({ status: 'unknown' });
    expect(AuthLib.readAccessToken()).toBeNull();
    expect(events).toEqual([]);
  });

  it('holds the intermediate token in memory, where nothing renders it', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(secondFactorRequired()));
    const { AuthLib, AuthService } = await freshUnit();

    const { result } = renderHook(() => AuthService.useLogin(), { wrapper: wrapper() });
    result.current.submit(CREDENTIALS);

    await waitFor(() => {
      expect(result.current.step).toBe('second-factor');
    });
    expect(AuthLib.readMfaToken()).toBe(MFA_TOKEN);
  });

  it('counts the life of that token down from what the answer said', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(secondFactorRequired(300)));
    const { AuthService } = await freshUnit();

    const { result } = renderHook(() => AuthService.useLogin(), { wrapper: wrapper() });
    result.current.submit(CREDENTIALS);

    await waitFor(() => {
      expect(result.current.step).toBe('second-factor');
    });
    expect(result.current.secondFactor.secondsLeft).toBe(300);
  });

  it('exchanges the code for a session, and announces it once', async () => {
    const transport = twoStepTransport(signedIn);
    vi.stubGlobal('fetch', transport.fetch);
    const { AuthLib, AuthService } = await freshUnit();
    const events: string[] = [];
    const unsubscribe = AuthLib.onAuthEvent((event) => events.push(event));

    const { result } = renderHook(() => AuthService.useLogin(), { wrapper: wrapper() });
    result.current.submit(CREDENTIALS);

    await waitFor(() => {
      expect(result.current.step).toBe('second-factor');
    });

    result.current.secondFactor.submit({ code: '123456' });

    await waitFor(() => {
      expect(AuthService.authSession.read()).toEqual({
        status: 'authenticated',
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
      });
    });
    unsubscribe();
    expect(events).toEqual(['logged-in']);
    expect(transport.requests).toEqual(['login', 'verify']);
  });

  it('stays on the step when the code is wrong, and says which refusal it was', async () => {
    vi.stubGlobal('fetch', twoStepTransport(() => secondFactorRefused('mfa_invalid_code')).fetch);
    const { AuthService } = await freshUnitAndShared();

    const { result } = renderHook(() => AuthService.useLogin(), { wrapper: wrapper() });
    result.current.submit(CREDENTIALS);

    await waitFor(() => {
      expect(result.current.step).toBe('second-factor');
    });

    result.current.secondFactor.submit({ code: '000000' });

    await waitFor(() => {
      expect(result.current.secondFactor.failure).toEqual({ key: 'errors.code.mfa_invalid_code' });
    });
    expect(result.current.step).toBe('second-factor');
  });

  /**
   * The refusal the whole step turns on: a token the server no longer accepts cannot be retried,
   * and a screen that kept asking for a code would be asking for one nothing can spend. Back to the
   * password, with the sentence that says why.
   */
  it('returns to the password when the server says the step has expired', async () => {
    vi.stubGlobal('fetch', twoStepTransport(() => secondFactorRefused('mfa_token_expired')).fetch);
    const { AuthService } = await freshUnitAndShared();

    const { result } = renderHook(() => AuthService.useLogin(), { wrapper: wrapper() });
    result.current.submit(CREDENTIALS);

    await waitFor(() => {
      expect(result.current.step).toBe('second-factor');
    });

    result.current.secondFactor.submit({ code: '123456' });

    await waitFor(() => {
      expect(result.current.step).toBe('password');
    });
    expect(result.current.notice).toEqual({ key: 'errors.code.mfa_token_expired' });
  });

  /**
   * The same ending reached by the clock rather than by the server. `expiresIn: 0` is a token that
   * is dead on arrival, which is what the last second of a countdown looks like — the step is never
   * drawn and the person is asked for the password again instead of typing into a corpse.
   */
  it('returns to the password when the countdown has nothing left to count', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(secondFactorRequired(0)));
    const { AuthService } = await freshUnit();

    const { result } = renderHook(() => AuthService.useLogin(), { wrapper: wrapper() });
    result.current.submit(CREDENTIALS);

    await waitFor(() => {
      expect(result.current.notice).toEqual({ key: 'errors.code.mfa_token_expired' });
    });
    expect(result.current.step).toBe('password');
    expect(result.current.secondFactor.secondsLeft).toBe(0);
  });

  /**
   * A second password attempt starts a clean step. Without the reset, the refusal of the previous
   * attempt would still be on the mutation — so an expired token would send the screen straight
   * back to the password it had just been given, and a wrong code would greet the next step before
   * anything was typed into it.
   */
  it('clears the previous refusal when the password is submitted again', async () => {
    vi.stubGlobal('fetch', twoStepTransport(() => secondFactorRefused('mfa_invalid_code')).fetch);
    const { AuthService } = await freshUnitAndShared();

    const { result } = renderHook(() => AuthService.useLogin(), { wrapper: wrapper() });
    result.current.submit(CREDENTIALS);

    await waitFor(() => {
      expect(result.current.step).toBe('second-factor');
    });

    result.current.secondFactor.submit({ code: '000000' });

    await waitFor(() => {
      expect(result.current.secondFactor.failure).toEqual({ key: 'errors.code.mfa_invalid_code' });
    });

    result.current.submit(CREDENTIALS);

    await waitFor(() => {
      expect(result.current.secondFactor.failure).toBeUndefined();
    });
    expect(result.current.step).toBe('second-factor');
  });

  /**
   * A second password attempt disposes of the token the first one minted, whichever way it goes.
   *
   * **One stub, answering differently per call**, rather than a second `vi.stubGlobal`: the typed
   * client captures `globalThis.fetch` when its module is created, so re-stubbing afterwards
   * replaces a reference nothing reads. The first version of this case did exactly that, watched
   * the *first* answer arrive twice, and concluded the token had survived a refusal it never saw.
   */
  it('disposes of the intermediate token when a new password attempt is made', async () => {
    let attempt = 0;

    vi.stubGlobal('fetch', () => {
      attempt += 1;

      return Promise.resolve(attempt === 1 ? secondFactorRequired() : refused());
    });

    const { AuthLib, AuthService } = await freshUnit();

    const { result } = renderHook(() => AuthService.useLogin(), { wrapper: wrapper() });
    result.current.submit(CREDENTIALS);

    await waitFor(() => {
      expect(AuthLib.readMfaToken()).toBe(MFA_TOKEN);
    });

    result.current.submit(CREDENTIALS);

    await waitFor(() => {
      expect(() => AuthLib.readMfaToken()).toThrow(/no second factor/i);
    });
    expect(attempt).toBe(2);
    expect(AuthService.authSession.read()).toEqual({ status: 'unknown' });
  });
});
