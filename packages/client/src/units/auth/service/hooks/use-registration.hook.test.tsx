import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi } from '@shared';

/**
 * Creating an installation's first organization, as the object a public screen can render.
 *
 * Three properties are asserted here that nothing else in the tree can assert.
 *
 * **The request body is built here, not in the markup.** The form owns five fields; the locale and
 * the time zone are things the interface already knows, and the contract's nesting is a shape no
 * component should have to hold (`rules/frontend-fsd.mdc` rule 5).
 *
 * **The two refusals the screen renders itself raise no toast.** A taken slug belongs under the slug
 * field and a closed installation replaces the form; the local `onError` of the mutation is what
 * stops the global `MutationCache.onError` adding a toast on top of either
 * (`rules/errors-and-toasts.mdc` §2–§4). Everything else the screen cannot place — a rate limit, a
 * 500 — still becomes exactly one signal, the notice above the fields.
 *
 * **Whether registration is open cannot be known before asking.** `GET /api/v1/meta` publishes an
 * API version and a clock and nothing else, so `registration_disabled` is learned from the answer
 * to the one request that can be refused for it — and once learned, the form is gone.
 */
const USER_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const VALUES = {
  organizationName: 'Bad Company',
  slug: 'bad-company',
  email: 'ada@example.com',
  password: 'correct-horse-battery',
  confirmPassword: 'correct-horse-battery',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const registered = (): Response =>
  json(
    {
      status: 'authenticated',
      accessToken: 'access-token-of-the-owner',
      tokenType: 'Bearer',
      expiresIn: 900,
      user: { id: USER_ID, email: 'ada@example.com', locale: 'en', timezone: 'Europe/Berlin' },
      organization: { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
    },
    201,
  );

const refused = (code: string, status: number): Response =>
  json(
    {
      type: `https://bad-crm.dev/problems/${code}`,
      title: 'Registration refused',
      status,
      code,
      requestId: 'req-register',
    },
    status,
  );

interface Harness {
  readonly queryClient: QueryClient;
  readonly notify: {
    readonly success: ReturnType<typeof vi.fn>;
    readonly error: ReturnType<typeof vi.fn>;
  };
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

/** A spy over the port the query client shouts through, so «no toast» is observable. */
const harness = (): Harness => {
  const notify = { success: vi.fn(), error: vi.fn() };
  const queryClient = SharedApi.createAppQueryClient({ notify, logError: vi.fn() });

  return {
    queryClient,
    notify,
    wrapper: function Wrapper({ children }: { readonly children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    },
  };
};

/**
 * The unit **and** the shared layer it threw the error from, out of the same fresh module graph —
 * for the reason `verify-second-factor.mutation.test.tsx` states: `isApiError` recognises a failure
 * by `instanceof`, and a second module graph mints a second class.
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

describe('registering an organization', () => {
  it('sends the contract shape, with the locale and the zone the form never asked for', async () => {
    const bodies: unknown[] = [];

    vi.stubGlobal('fetch', async (request: Request) => {
      bodies.push(await request.clone().json());

      return registered();
    });

    const { AuthService } = await freshUnit();
    const { result } = renderHook(() => AuthService.useRegistration(), {
      wrapper: harness().wrapper,
    });

    act(() => {
      result.current.submit(VALUES);
    });

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]).toEqual({
      organization: { name: 'Bad Company', slug: 'bad-company' },
      owner: {
        email: 'ada@example.com',
        password: 'correct-horse-battery',
        locale: expect.any(String),
        timezone: expect.any(String),
      },
    });
  });

  it('signs the tab in: token in memory, session in the store, one announcement', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(registered()));

    const { AuthLib, AuthService } = await freshUnit();
    const events: string[] = [];
    const unsubscribe = AuthLib.onAuthEvent((event) => events.push(event));

    const { result } = renderHook(() => AuthService.useRegistration(), {
      wrapper: harness().wrapper,
    });

    act(() => {
      result.current.submit(VALUES);
    });

    await waitFor(() => {
      expect(events).toEqual(['logged-in']);
    });
    expect(AuthLib.readAccessToken()).toBe('access-token-of-the-owner');
    unsubscribe();
  });

  /**
   * An answer this client cannot read is not a session, and nothing may act as though it were.
   *
   * `adoptSession` parses before it trusts (`lib/adopt-session.util.ts`): a document without the two
   * identifiers it needs — a client and a server out of step — clears the token and answers `null`.
   * The store must stay empty and the bus silent, because a tab that announced `logged-in` on that
   * answer would be carried into the application holding nothing, where the first guard bounces it
   * back with no explanation.
   */
  it('does not sign the tab in on an answer it could not parse', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(json({ status: 'authenticated', accessToken: 'token' }, 201)),
    );

    const { AuthLib, AuthService } = await freshUnit();
    const events: string[] = [];
    const unsubscribe = AuthLib.onAuthEvent((event) => events.push(event));

    const { result } = renderHook(() => AuthService.useRegistration(), {
      wrapper: harness().wrapper,
    });

    act(() => {
      result.current.submit(VALUES);
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });
    expect(events).toEqual([]);
    expect(AuthLib.readAccessToken()).toBeNull();
    unsubscribe();
  });

  it('puts a taken slug under the slug field and raises no toast', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(refused('organization_already_exists', 409)));

    const { AuthService } = await freshUnit();
    const stand = harness();
    const { result } = renderHook(() => AuthService.useRegistration(), { wrapper: stand.wrapper });

    act(() => {
      result.current.submit(VALUES);
    });

    await waitFor(() => {
      expect(result.current.slugErrorKey).toBe('errors.code.organization_already_exists');
    });
    expect(result.current.noticeKey).toBeUndefined();
    expect(result.current.isClosed).toBe(false);
    expect(stand.notify.error).not.toHaveBeenCalled();
  });

  it('takes the form away when the installation is closed, and raises no toast', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(refused('registration_disabled', 403)));

    const { AuthService } = await freshUnit();
    const stand = harness();
    const { result } = renderHook(() => AuthService.useRegistration(), { wrapper: stand.wrapper });

    act(() => {
      result.current.submit(VALUES);
    });

    await waitFor(() => {
      expect(result.current.isClosed).toBe(true);
    });
    expect(result.current.noticeKey).toBeUndefined();
    expect(result.current.slugErrorKey).toBeUndefined();
    expect(stand.notify.error).not.toHaveBeenCalled();
  });

  it('reports every other refusal once, above the fields', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(refused('rate_limited', 429)));

    const { AuthService } = await freshUnit();
    const stand = harness();
    const { result } = renderHook(() => AuthService.useRegistration(), { wrapper: stand.wrapper });

    act(() => {
      result.current.submit(VALUES);
    });

    await waitFor(() => {
      expect(result.current.noticeKey).toBe('errors.code.rate_limited');
    });
    expect(result.current.slugErrorKey).toBeUndefined();
    expect(result.current.isClosed).toBe(false);
    expect(stand.notify.error).not.toHaveBeenCalled();
  });

  it('carries the wait for the button and nothing else', async () => {
    // Held open on purpose: a `fetch` that resolves in the same tick is never observably in flight,
    // and the assertion would be racing the answer rather than reading the state.
    let answer = (_response: Response) => undefined as void;
    vi.stubGlobal(
      'fetch',
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );

    const { AuthService } = await freshUnit();
    const { result } = renderHook(() => AuthService.useRegistration(), {
      wrapper: harness().wrapper,
    });

    expect(result.current.isPending).toBe(false);

    act(() => {
      result.current.submit(VALUES);
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });
    expect(result.current.noticeKey).toBeUndefined();

    await act(async () => {
      answer(registered());
    });
  });
});
