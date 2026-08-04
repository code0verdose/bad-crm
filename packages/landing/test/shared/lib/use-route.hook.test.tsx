import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { navigate, ROUTES, useRoute } from '@/shared/lib/use-route.hook.js';

/**
 * There is no router here, on purpose — `use-route.hook.ts` is `location.pathname` plus a
 * subscription to two events. What has to be proven is exactly the part a dependency would
 * otherwise hide: `navigate` does not repaint anything by itself (`pushState` fires no event of its
 * own), an unknown path is not trusted, and the subscription is actually torn down on unmount.
 */
describe('useRoute', () => {
  afterEach(() => {
    // `pushState` leaks across tests in the same jsdom document; every test that moves the URL
    // resets it so the next one starts from the same place the whole suite assumes.
    globalThis.history.pushState(null, '', '/');
  });

  it('reads the current path as the initial route', () => {
    globalThis.history.pushState(null, '', ROUTES.terms);

    const { result } = renderHook(() => useRoute());

    expect(result.current).toBe(ROUTES.terms);
  });

  it('falls back to home for a path the landing does not serve', () => {
    globalThis.history.pushState(null, '', '/does-not-exist');

    const { result } = renderHook(() => useRoute());

    expect(result.current).toBe(ROUTES.home);
  });

  it('navigate() pushes history and dispatches the event the hook listens for', () => {
    const { result } = renderHook(() => useRoute());

    expect(result.current).toBe(ROUTES.home);

    act(() => {
      navigate(ROUTES.privacy);
    });

    expect(globalThis.location.pathname).toBe(ROUTES.privacy);
    expect(result.current).toBe(ROUTES.privacy);
  });

  it('pushState alone — without the custom event — does not repaint the hook', () => {
    const { result } = renderHook(() => useRoute());

    act(() => {
      globalThis.history.pushState(null, '', ROUTES.cookies);
    });

    // The URL moved, but nothing told React about it: this is exactly the gap `navigate()`'s
    // `bcl:navigate` event exists to close.
    expect(globalThis.location.pathname).toBe(ROUTES.cookies);
    expect(result.current).toBe(ROUTES.home);
  });

  it('an unknown path reached via popstate (e.g. the back button) also falls back to home', () => {
    const { result } = renderHook(() => useRoute());

    act(() => {
      globalThis.history.pushState(null, '', '/unknown');
      globalThis.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current).toBe(ROUTES.home);
  });

  it('unsubscribes both listeners on unmount', () => {
    const addSpy = vi.spyOn(globalThis, 'addEventListener');
    const removeSpy = vi.spyOn(globalThis, 'removeEventListener');

    const { unmount } = renderHook(() => useRoute());

    const subscribedEvents = addSpy.mock.calls
      .map(([type]) => type)
      .filter((type) => type === 'popstate' || type === 'bcl:navigate');
    expect(subscribedEvents.sort()).toEqual(['bcl:navigate', 'popstate']);

    unmount();

    const unsubscribedEvents = removeSpy.mock.calls
      .map(([type]) => type)
      .filter((type) => type === 'popstate' || type === 'bcl:navigate');
    expect(unsubscribedEvents.sort()).toEqual(['bcl:navigate', 'popstate']);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
