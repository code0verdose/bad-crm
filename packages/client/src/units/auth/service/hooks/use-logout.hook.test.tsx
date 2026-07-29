import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, SharedLib } from '@shared';

/**
 * Signing out, which has to work even when the request does not.
 *
 * `POST /auth/logout` revokes the session server-side and clears the refresh cookie. What this hook
 * owes on top is the local half — forget the access token, drop the session state, announce it —
 * and it owes it whether the request succeeded, was refused or never arrived. A tab that stays
 * signed in because the network blinked is worse than one that signs out of a session the server
 * still holds: the second is a cookie that expires, the first is an open workspace.
 */
const IDENTITY = {
  userId: 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e',
  organizationId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
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

describe('signing out', () => {
  it.each([
    ['the server confirms it', () => Promise.resolve(new Response(null, { status: 204 }))],
    ['the server refuses', () => Promise.resolve(new Response(null, { status: 401 }))],
    ['the network is gone', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('ends the session locally when %s', async (_case, fetchImpl) => {
    vi.stubGlobal('fetch', fetchImpl);
    const { AuthLib, AuthService } = await freshUnit();
    const events: string[] = [];
    const unsubscribe = AuthLib.onAuthEvent((event) => events.push(event));
    AuthService.authSession.start(IDENTITY as never);
    AuthLib.setAccessToken('access-token-1');

    const { result } = renderHook(() => AuthService.useLogout(), { wrapper: wrapper() });
    result.current.signOut();

    await waitFor(() => {
      expect(AuthService.authSession.read()).toEqual({ status: 'anonymous' });
    });
    unsubscribe();
    expect(AuthLib.readAccessToken()).toBeNull();
    expect(events).toContain('logged-out');
  });

  /** A transport that never answers, so «in flight» is observable rather than a race with the stub. */
  it('reports the request in flight, so the control can carry the wait', async () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined));
    const { AuthService } = await freshUnit();

    const { result } = renderHook(() => AuthService.useLogout(), { wrapper: wrapper() });
    expect(result.current.isPending).toBe(false);
    result.current.signOut();

    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });
  });
});
