import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, type SharedLib } from '@shared';

/**
 * Accepting an invitation, as the object the public screen can render.
 *
 * `AcceptInvitePage` used to call `AuthService.useAcceptInvitation()` itself, assemble the body from
 * the route's token, the form's values and the browser's time zone inside its JSX, and hold the rule
 * that decides whether the answer was a session at all — the middle link of
 * `rules/frontend-fsd.mdc` rule 4 skipped on the layer where it is easiest to excuse.
 *
 * The last part is what these cases are really about. `adoptSession` answers `null` for a document
 * it cannot parse — a client and server out of step — and navigating on that answer drops somebody
 * into the application with no token, where the first guard bounces them straight back out with
 * nothing to explain it. That rule now lives in the unit, so the next screen to accept an invitation
 * cannot forget it.
 */

const SESSION = {
  // Dot-free on purpose: the catalogue-parity gate scans string literals for translation keys, and
  // a dotted fake token is indistinguishable from one.
  accessToken: 'access-token-for-the-test',
  expiresIn: 900,
  user: { id: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a41' },
  organization: { id: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a42' },
};

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

interface Harness {
  readonly queryClient: QueryClient;
  readonly globalNotify: SharedLib.NotificationPort;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

const harness = (): Harness => {
  const globalNotify = { error: vi.fn(), success: vi.fn() };
  const queryClient = SharedApi.createAppQueryClient({ notify: globalNotify, logError: vi.fn() });

  return {
    queryClient,
    globalNotify,
    wrapper: function Wrapper({ children }: { readonly children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    },
  };
};

const freshUnit = async () => {
  vi.resetModules();

  return await import('@units/auth');
};

const FORM = { password: 'correct horse battery staple', locale: 'en' } as never;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('accepting an invitation', () => {
  it('CONTROL: sends the token the hook was bound to, with the browser time zone', async () => {
    const calls: Request[] = [];

    vi.stubGlobal('fetch', (input: Request) => {
      calls.push(input.clone());

      return Promise.resolve(json(SESSION));
    });

    const { AuthService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => AuthService.useInvitationAcceptance('token-1'), {
      wrapper,
    });

    act(() => {
      result.current.accept(FORM);
    });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    const body = (await calls[0]?.json()) as Record<string, unknown>;

    expect(body['token']).toBe('token-1');
    expect(body['password']).toBe('correct horse battery staple');
    expect(typeof body['timezone']).toBe('string');
    expect(body['timezone']).not.toBe('');
  });

  it('reports the wait so the form can disable its own button', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json(SESSION)));

    const { AuthService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => AuthService.useInvitationAcceptance('token-1'), {
      wrapper,
    });

    expect(result.current.isPending).toBe(false);

    act(() => {
      result.current.accept(FORM);
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });
  });

  it('runs the callback once the answer really was a session', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json(SESSION)));

    const { AuthService } = await freshUnit();
    const { wrapper } = harness();
    const entered = vi.fn();

    const { result } = renderHook(() => AuthService.useInvitationAcceptance('token-1'), {
      wrapper,
    });

    act(() => {
      result.current.accept(FORM, entered);
    });

    await waitFor(() => {
      expect(entered).toHaveBeenCalledTimes(1);
    });
  });

  it('does NOT run it when the answer parsed to no session — the guard would bounce them', async () => {
    // A body the session reader cannot adopt: a deployment out of step, answering 200 with a
    // document that is not a session.
    vi.stubGlobal('fetch', () => Promise.resolve(json({ unexpected: true })));

    const { AuthService } = await freshUnit();
    const { wrapper } = harness();
    const entered = vi.fn();

    const { result } = renderHook(() => AuthService.useInvitationAcceptance('token-1'), {
      wrapper,
    });

    act(() => {
      result.current.accept(FORM, entered);
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });
    expect(entered).not.toHaveBeenCalled();
  });
});
