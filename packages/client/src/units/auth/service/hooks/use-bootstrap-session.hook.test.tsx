import { renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The hook the shell reads, wired to the module instance the application actually ships — the store,
 * the deduplicating refresh and the transport underneath it.
 *
 * That wiring is the subject. `auth-session.store.test.ts` proves the state machine on a store of
 * its own; what cannot be proved there is that the hook starts the one exchange at all, and starting
 * it is the whole story: a hook that only *reads* leaves `unknown` for ever, and `unknown` is the
 * state in which the guards deliberately do nothing.
 *
 * Each case re-imports the unit after `vi.resetModules()`, because the store is a module singleton
 * by design — one session per tab. Vitest does not reset externalised dependencies, so React stays
 * the single instance `@testing-library/react` is holding.
 */
const USER_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const authenticated = (): Response =>
  new Response(
    JSON.stringify({
      status: 'authenticated',
      accessToken: 'access-token-1',
      tokenType: 'Bearer',
      expiresIn: 900,
      user: { id: USER_ID, email: 'ada@example.com', locale: 'en', timezone: 'Europe/Berlin' },
      organization: { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const refused = (): Response => new Response(null, { status: 401 });

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

describe('the session bootstrap', () => {
  it('starts as unknown, so nothing decides anything before the answer', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(refused()));
    const { AuthService } = await freshUnit();

    const { result } = renderHook(() => AuthService.useBootstrapSession());

    expect(result.current).toEqual({ status: 'unknown' });
  });

  it('becomes authenticated when the refresh cookie is still good', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(authenticated()));
    const { AuthService } = await freshUnit();

    const { result } = renderHook(() => AuthService.useBootstrapSession());

    await waitFor(() => {
      expect(result.current).toEqual({
        status: 'authenticated',
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
      });
    });
  });

  it('becomes anonymous when there is no session to restore', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(refused()));
    const { AuthService } = await freshUnit();

    const { result } = renderHook(() => AuthService.useBootstrapSession());

    await waitFor(() => {
      expect(result.current).toEqual({ status: 'anonymous' });
    });
  });

  /**
   * `StrictMode` renders twice and mounts twice, and the application runs under it in every
   * environment (`app/main.tsx`). Two exchanges would present the refresh token twice, which is
   * the definition of reuse — the server revokes the whole family and signs the user out of every
   * device (`docs/api/openapi.yaml` → `POST /auth/refresh`).
   */
  it('exchanges once even under StrictMode, and once more for a second reader', async () => {
    const exchanges: string[] = [];
    vi.stubGlobal('fetch', (request: Request) => {
      exchanges.push(request.url);

      return Promise.resolve(authenticated());
    });
    const { AuthService } = await freshUnit();

    renderHook(() => AuthService.useBootstrapSession(), { wrapper: StrictMode });
    const second = renderHook(() => AuthService.useBootstrapSession(), { wrapper: StrictMode });

    await waitFor(() => {
      expect(second.result.current.status).toBe('authenticated');
    });
    expect(exchanges).toHaveLength(1);
  });

  /**
   * What the shell renders from must not be able to carry the credential. Where the token is *not*
   * written is asserted from outside this unit, in `test/app/session-bootstrap.test.tsx`: naming
   * the two Web Storage APIs in a file under `units/auth/**` is itself banned, by ESLint and by
   * `test/architecture/data-layer-conventions.test.ts`.
   */
  it('hands the shell an identity and never the access token', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(authenticated()));
    const { AuthService } = await freshUnit();

    const { result } = renderHook(() => AuthService.useBootstrapSession());
    await waitFor(() => {
      expect(result.current.status).toBe('authenticated');
    });

    expect(JSON.stringify(result.current)).not.toContain('access-token-1');
  });
});
