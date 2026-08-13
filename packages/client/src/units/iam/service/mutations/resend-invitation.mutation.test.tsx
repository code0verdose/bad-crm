import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, type SharedLib } from '@shared';

/**
 * Re-issuing a link: what the mutation owes besides the request.
 *
 * The list is invalidated (the expiry moved, and a row that has just been accepted should not be
 * there at all); **nothing is announced**, because the signal is the panel with the new link in it,
 * which the screen has to show anyway — a toast beside it is the second signal for one action.
 */

const INVITATION_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b01';
const INVITE_URL = 'https://crm.example.test/invite/opaque-token';

const minted = (): Response =>
  new Response(
    JSON.stringify({
      id: INVITATION_ID,
      email: 'ivan@example.test',
      inviteUrl: INVITE_URL,
      expiresAt: '2026-08-27T10:00:00.000Z',
      mailDispatched: true,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const problem = (): Response =>
  new Response(
    JSON.stringify({
      type: 'https://bad-crm.dev/problems/invitation_already_accepted',
      title: 'invitation_already_accepted',
      status: 409,
      code: 'invitation_already_accepted',
      requestId: 'req-1',
    }),
    { status: 409, headers: { 'content-type': 'application/problem+json' } },
  );

interface Harness {
  readonly queryClient: QueryClient;
  /** Spied rather than silenced — a silent port would make «no toast» true by construction. */
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

  const [iam, shared] = await Promise.all([import('@units/iam'), import('@shared')]);

  return { ...iam, notify: shared.SharedUi.notify, QueryKeys: shared.SharedLib.QueryKeys };
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('re-issuing an invitation', () => {
  it('CONTROL: succeeds and answers with the new link', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(minted()));
    const { IamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => IamService.IamMutations.useResendInvitation(), { wrapper });

    result.current.mutate(INVITATION_ID);

    await waitFor(() => {
      expect(result.current.data?.inviteUrl).toBe(INVITE_URL);
    });
  });

  it('invalidates the list, because the expiry it shows has moved', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(minted()));
    const { IamService, QueryKeys } = await freshUnit();
    const { queryClient, wrapper } = harness();

    queryClient.setQueryData(QueryKeys.Invitations.list(), []);
    queryClient.setQueryData(QueryKeys.Roles.matrix(), []);

    const { result } = renderHook(() => IamService.IamMutations.useResendInvitation(), { wrapper });

    result.current.mutate(INVITATION_ID);

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(queryClient.getQueryState(QueryKeys.Invitations.list())?.isInvalidated).toBe(true);
    // The neighbour nothing here touches: invalidating the whole cache would satisfy the line above.
    expect(queryClient.getQueryState(QueryKeys.Roles.matrix())?.isInvalidated).toBe(false);
  });

  it('announces nothing on success — the link panel is the signal', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(minted()));
    const { IamService, notify } = await freshUnit();
    const { globalNotify, wrapper } = harness();
    const success = vi.spyOn(notify, 'success');

    const { result } = renderHook(() => IamService.IamMutations.useResendInvitation(), { wrapper });

    result.current.mutate(INVITATION_ID);

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(success).not.toHaveBeenCalled();
    expect(globalNotify.success).not.toHaveBeenCalled();
  });

  /**
   * `409 invitation_already_accepted` is the refusal this operation really produces, and it belongs
   * inside the dialog that asked for the confirmation — an `aria-modal` surface, outside which a
   * toast is no signal at all for a screen-reader user. The local `onError` is what makes the
   * global handler stand aside (`rules/tanstack-query.mdc` §10).
   */
  it('leaves a refusal to the dialog rather than to the toaster', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem()));
    const { IamService, notify } = await freshUnit();
    const { globalNotify, wrapper } = harness();
    const error = vi.spyOn(notify, 'error');

    const { result } = renderHook(() => IamService.IamMutations.useResendInvitation(), { wrapper });

    result.current.mutate(INVITATION_ID);

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toMatchObject({ code: 'invitation_already_accepted' });
    expect(globalNotify.error).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
