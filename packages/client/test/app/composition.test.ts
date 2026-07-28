import { afterEach, describe, expect, it, vi } from 'vitest';

import { installApiMiddleware } from '@app/api-middleware.util.js';
import { subscribeAuthRedirect, type AuthRedirectTarget } from '@app/auth-redirect.util.js';
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

describe('the sign-out subscription', () => {
  const targetSpy = (): { target: AuthRedirectTarget; navigate: ReturnType<typeof vi.fn> } => {
    const navigate = vi.fn();
    return {
      navigate,
      target: { state: { location: { href: '/projects/42/board/7' } }, navigate },
    };
  };

  it('sends the tab to the login screen, carrying the page it was thrown out of', () => {
    const { target, navigate } = targetSpy();
    const unsubscribe = subscribeAuthRedirect(target);

    AuthLib.emitAuthEvent('logged-out');

    expect(navigate).toHaveBeenCalledWith({
      to: '/login',
      search: { redirect: '/projects/42/board/7' },
      replace: true,
    });

    unsubscribe();
  });

  /**
   * `refresh-failed` is the earlier moment — the rotation was refused, the tab may still hold a
   * valid access token — and `units/auth` follows it with `logged-out` when the session is really
   * over. Navigating on both would race the second event against the first navigation.
   */
  it('ignores a failed refresh, which is not yet a sign-out', () => {
    const { target, navigate } = targetSpy();
    const unsubscribe = subscribeAuthRedirect(target);

    AuthLib.emitAuthEvent('refresh-failed');
    AuthLib.emitAuthEvent('logged-in');

    expect(navigate).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('stops listening once unsubscribed', () => {
    const { target, navigate } = targetSpy();

    subscribeAuthRedirect(target)();
    AuthLib.emitAuthEvent('logged-out');

    expect(navigate).not.toHaveBeenCalled();
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
