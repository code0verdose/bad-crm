import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, type SharedLib } from '@shared';

/**
 * The two actions on an open invitation, at the seam where they differ.
 *
 * Both take an optional `onDone`, and the screen passes one to exactly one of them: revoking closes
 * the dialog because the row it was about is gone, re-issuing keeps it open because the link it
 * produced is the only copy that will ever exist. That asymmetry is the whole design, and until now
 * only one side of each was exercised — the widget passes a callback to the revoke and none to the
 * re-issue, and from outside the dialog the two look identical. `InvitationAction` is deliberately
 * one shape used twice, so both sides of both are asserted here: that symmetry is what makes the
 * next caller of it safe.
 */

const INVITATION = {
  id: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a41',
  email: 'colleague@example.test',
  roleId: null,
  teamIds: [],
  invitedById: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a42',
  expiresAt: '2099-01-01T00:00:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
};

const MINTED = {
  id: INVITATION.id,
  email: INVITATION.email,
  inviteUrl: 'https://crm.example.test/accept/token',
  expiresAt: INVITATION.expiresAt,
  mailDispatched: true,
};

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const problem = (code: string, status: number): Response =>
  new Response(
    JSON.stringify({
      type: `https://bad-crm.dev/problems/${code}`,
      title: code,
      status,
      code,
      requestId: 'req-1',
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

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

  return await import('@units/iam');
};

/** The list, then whatever each action's own request answers. */
const stubApi = (answer: (request: Request) => Response) => {
  vi.stubGlobal('fetch', (input: Request) =>
    Promise.resolve(input.method === 'GET' ? json({ items: [INVITATION] }) : answer(input.clone())),
  );
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the two actions on an open invitation', () => {
  it('CONTROL: lists what the server returned, judged expired against the clock here', async () => {
    stubApi(() => json({}));

    const { IamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => IamService.IamHooks.useInvitationList(), { wrapper });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]?.isExpired).toBe(false);
  });

  it('runs the callback the revoke was given, once the server agreed', async () => {
    stubApi(() => new Response(null, { status: 204 }));

    const { IamService } = await freshUnit();
    const { wrapper } = harness();
    const closed = vi.fn();

    const { result } = renderHook(() => IamService.IamHooks.useInvitationList(), { wrapper });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    act(() => {
      result.current.revoke.run(INVITATION.id, closed);
    });

    await waitFor(() => {
      expect(closed).toHaveBeenCalledTimes(1);
    });
  });

  it('accepts a re-issue with no callback, and hands back the one link it minted', async () => {
    stubApi(() => json(MINTED, 201));

    const { IamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => IamService.IamHooks.useInvitationList(), { wrapper });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    // No second argument: the dialog stays open on this one, because what it has to show is the
    // link that only exists in this answer.
    act(() => {
      result.current.resend.run(INVITATION.id);
    });

    await waitFor(() => {
      expect(result.current.minted).toMatchObject({ inviteUrl: MINTED.inviteUrl });
    });
  });

  it('accepts a revoke with no callback — the caller decides, not the action', async () => {
    stubApi(() => new Response(null, { status: 204 }));

    const { IamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => IamService.IamHooks.useInvitationList(), { wrapper });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    act(() => {
      result.current.revoke.run(INVITATION.id);
    });

    await waitFor(() => {
      expect(result.current.revoke.isPending).toBe(false);
    });
    expect(result.current.revoke.failureKey).toBeUndefined();
  });

  it('runs the callback a re-issue was given, for the caller that wants one', async () => {
    stubApi(() => json(MINTED, 201));

    const { IamService } = await freshUnit();
    const { wrapper } = harness();
    const done = vi.fn();

    const { result } = renderHook(() => IamService.IamHooks.useInvitationList(), { wrapper });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    act(() => {
      result.current.resend.run(INVITATION.id, done);
    });

    await waitFor(() => {
      expect(done).toHaveBeenCalledTimes(1);
    });
  });

  it('hands each refusal to `ui` as a sentence key, and forgets it on dismissal', async () => {
    stubApi(() => problem('invitation_not_found', 404));

    const { IamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => IamService.IamHooks.useInvitationList(), { wrapper });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    act(() => {
      result.current.resend.run(INVITATION.id);
    });

    await waitFor(() => {
      expect(result.current.resend.failureKey).toBeDefined();
    });

    act(() => {
      result.current.resend.reset();
    });

    await waitFor(() => {
      expect(result.current.resend.failureKey).toBeUndefined();
    });
  });
});
