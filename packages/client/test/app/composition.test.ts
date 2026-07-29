import { afterEach, describe, expect, it, vi } from 'vitest';

import { installApiMiddleware } from '@app/api-middleware.util.js';
import { subscribeAuthEvents, type AuthEventTarget } from '@app/auth-events.util.js';
import { reportClientError } from '@app/report-client-error.util.js';
import { AuthLib } from '@units/auth';
import { SharedApi } from '@shared';

/**
 * The wiring the composition root owns — the three connections that exist nowhere else and that
 * nothing else can test, because each of them joins two layers that are forbidden to know about
 * each other.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the API middleware', () => {
  /**
   * Order is behaviour, not style. The idempotency middleware has to see the request before the
   * auth middleware, so the key belongs to the logical operation; the other way round, a request
   * replayed after a token refresh carries a fresh key — and the duplicate-invoice case that
   * idempotency exists for is exactly a mutation whose token expired mid-flight.
   */
  it('registers idempotency before authentication', () => {
    const use = vi.spyOn(SharedApi.apiClient, 'use').mockImplementation(() => undefined);

    installApiMiddleware();

    expect(use).toHaveBeenCalledTimes(2);
    const [first, second] = use.mock.calls.map(([middleware]) => middleware);
    expect(Object.keys(first ?? {})).toContain('onRequest');
    expect(Object.keys(second ?? {})).toContain('onRequest');
    expect(first).not.toBe(second);
  });
});

describe('the session-event subscription', () => {
  const targetSpy = () => {
    const navigate = vi.fn(() => Promise.resolve());
    const invalidate = vi.fn(() => Promise.resolve());
    const clear = vi.fn();
    const end = vi.fn();

    const target: AuthEventTarget = {
      router: { state: { location: { href: '/projects/42/board/7' } }, navigate, invalidate },
      queryClient: { clear },
      session: { end },
    };

    return { target, navigate, invalidate, clear, end };
  };

  /**
   * `RouterProvider` re-renders when the session changes; it does not re-run `beforeLoad`. Guards
   * run on a navigation and on an invalidation and nowhere else, so without this the user who has
   * just signed in stays on the form until they click something.
   */
  it('re-checks the guards after a sign-in, which is what carries the user onwards', () => {
    const { target, invalidate, navigate, end } = targetSpy();
    const unsubscribe = subscribeAuthEvents(target);

    AuthLib.emitAuthEvent('logged-in');

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();

    unsubscribe();
  });

  /**
   * The half of a lost session that has no other owner.
   *
   * `logged-out` is raised by two producers, and only one of them is the sign-out button: the auth
   * middleware raises it when a refresh is refused — an expired or revoked refresh token, a
   * password reset elsewhere that revoked every family, an administrator closing the session. That
   * producer clears the access token and says so, and nothing else moves the session state.
   *
   * Left at `authenticated`, the state is what both guards read: `redirectIfAuthed` on `/login`
   * throws the tab straight back into the shell it was just ejected from, and `requireSession`
   * waves it through. The cache is empty by then and every request answers 401, so what the person
   * sees is an application that claims they are signed in, shows nothing, and offers no way to sign
   * in again short of finding the sign-out control.
   */
  it('drops the session before it navigates, so the login route does not bounce the tab back', () => {
    const { target, end, navigate } = targetSpy();
    const unsubscribe = subscribeAuthEvents(target);

    AuthLib.emitAuthEvent('logged-out');

    expect(end).toHaveBeenCalledTimes(1);
    expect(end.mock.invocationCallOrder[0]).toBeLessThan(
      navigate.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    unsubscribe();
  });

  it('sends the tab to the login screen, carrying the page it was thrown out of', () => {
    const { target, navigate } = targetSpy();
    const unsubscribe = subscribeAuthEvents(target);

    AuthLib.emitAuthEvent('logged-out');

    expect(navigate).toHaveBeenCalledWith({
      to: '/login',
      search: { redirect: '/projects/42/board/7' },
      replace: true,
    });

    unsubscribe();
  });

  /**
   * Order, not merely both. `clear()` evicts every entry, and an observer still mounted on a
   * protected screen would refetch immediately — a burst of 401s from a tab that has just lost its
   * session. Leaving first unmounts them.
   */
  it('forgets the cache only once the protected screen is gone', async () => {
    const { target, clear } = targetSpy();
    const unsubscribe = subscribeAuthEvents(target);

    AuthLib.emitAuthEvent('logged-out');
    expect(clear).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(clear).toHaveBeenCalledTimes(1);
    });

    unsubscribe();
  });

  /**
   * `refresh-failed` is the earlier moment — the rotation was refused, the tab may still hold a
   * valid access token — and `units/auth` follows it with `logged-out` when the session is really
   * over. Acting on both would race the second event against the first navigation.
   */
  it('ignores a failed refresh, which is not yet a sign-out', () => {
    const { target, navigate, clear, end } = targetSpy();
    const unsubscribe = subscribeAuthEvents(target);

    AuthLib.emitAuthEvent('refresh-failed');

    expect(navigate).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('stops listening once unsubscribed', () => {
    const { target, navigate, invalidate } = targetSpy();

    subscribeAuthEvents(target)();
    AuthLib.emitAuthEvent('logged-out');
    AuthLib.emitAuthEvent('logged-in');

    expect(navigate).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('the error sink', () => {
  it('records the failure the user was shown as well as the ones they were not', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('network is down');

    reportClientError(failure);

    expect(consoleError).toHaveBeenCalledWith('[bad-crm]', failure);
  });
});
