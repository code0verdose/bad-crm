import { describe, expect, it, vi } from 'vitest';

import { emitAuthEvent, onAuthEvent } from '@units/auth/lib';
import { AUTH_EVENTS } from '@units/auth/model';

/**
 * The bus exists because the transport layer must not know about the router.
 *
 * A refresh fails inside a `fetch` middleware, and the reaction — clear the session, send the user
 * to `/login?redirect=…` — belongs to the application shell. Wiring the middleware straight to a
 * navigation would make `shared/api` depend on the router, invert the FSD layer direction and make
 * the failure untestable without mounting one. An event is the seam: the middleware announces, and
 * whoever owns navigation subscribes.
 */
describe('the auth event bus', () => {
  it('delivers an event to a subscriber', () => {
    const handler = vi.fn();
    const unsubscribe = onAuthEvent(handler);

    emitAuthEvent('logged-out');
    unsubscribe();

    expect(handler).toHaveBeenCalledExactlyOnceWith('logged-out');
  });

  it('delivers to every subscriber, not only to the first', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = onAuthEvent(first);
    const unsubscribeSecond = onAuthEvent(second);

    emitAuthEvent('refresh-failed');
    unsubscribeFirst();
    unsubscribeSecond();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops delivering after the subscriber unsubscribes', () => {
    const handler = vi.fn();

    onAuthEvent(handler)();
    emitAuthEvent('logged-out');

    expect(handler).not.toHaveBeenCalled();
  });

  /**
   * A double unsubscribe is what an effect cleanup produces under `StrictMode`, which mounts,
   * unmounts and mounts again. If the second call removed whatever now sits at the old index, an
   * unrelated subscriber would go deaf — and only in development.
   */
  it('survives being unsubscribed twice without silencing anybody else', () => {
    const kept = vi.fn();
    const unsubscribeKept = onAuthEvent(kept);
    const unsubscribeGone = onAuthEvent(vi.fn());

    unsubscribeGone();
    unsubscribeGone();
    emitAuthEvent('logged-in');
    unsubscribeKept();

    expect(kept).toHaveBeenCalledTimes(1);
  });

  it('publishes a closed vocabulary of events', () => {
    expect(AUTH_EVENTS).toEqual(['logged-in', 'logged-out', 'refresh-failed']);
  });
});
