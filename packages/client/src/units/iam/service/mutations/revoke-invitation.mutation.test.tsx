import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, type SharedLib } from '@shared';

/**
 * The three things closing an invitation owes, none of which a coverage report can see: the list is
 * invalidated, the success is reported **once**, and the failure is reported **not at all** here —
 * the dialog renders it, and a toast beside it would be the second signal for one action.
 */

const INVITATION_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b01';

const noContent = (): Response => new Response(null, { status: 204 });

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
  /**
   * The port the **global** `MutationCache` announces through, spied on.
   *
   * Not `SharedLib.silentNotifications`, which is what a cache-behaviour test would use: a silent
   * port makes «no toast on failure» true by construction, and the assertion below could never go
   * red. Measured — with the port silenced, deleting the mutation's own `onError` left this suite
   * entirely green.
   */
  readonly globalNotify: SharedLib.NotificationPort;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

const harness = (): Harness => {
  const globalNotify = { error: vi.fn(), success: vi.fn() };
  const queryClient = SharedApi.createAppQueryClient({
    notify: globalNotify,
    logError: vi.fn(),
  });

  return {
    queryClient,
    globalNotify,
    wrapper: function Wrapper({ children }: { readonly children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    },
  };
};

/**
 * `vi.resetModules()` rebuilds the client's module graph, the toaster included — so a spy placed on
 * a top-level `SharedUi.notify` would watch an object the freshly imported mutation never touches.
 * Both barrels are re-imported from the same fresh graph.
 */
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

describe('closing an invitation', () => {
  it('CONTROL: succeeds, so the assertions below are not about a failed request', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(noContent()));
    const { IamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => IamService.IamMutations.useRevokeInvitation(), { wrapper });

    result.current.mutate(INVITATION_ID);

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
  });

  it('invalidates the list, so the closed row leaves the screen', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(noContent()));
    const { IamService, QueryKeys } = await freshUnit();
    const { queryClient, wrapper } = harness();

    queryClient.setQueryData(QueryKeys.Invitations.list(), []);
    // A neighbour the operation must not touch: invalidating everything would «work» too.
    queryClient.setQueryData(QueryKeys.Permissions.mine(), {
      permissions: [],
      denied: [],
      roles: [],
      isOwner: false,
      version: 1,
    });

    const { result } = renderHook(() => IamService.IamMutations.useRevokeInvitation(), { wrapper });

    result.current.mutate(INVITATION_ID);

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(
      queryClient.getQueryState(QueryKeys.Invitations.list())?.isInvalidated,
      'the row is gone on the server; a list nobody re-read still shows it',
    ).toBe(true);
    expect(
      queryClient.getQueryState(QueryKeys.Permissions.mine())?.isInvalidated,
      'closing an invitation changes nobody’s permissions',
    ).toBe(false);
  });

  it('reports the success once, with a stable id', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(noContent()));
    const { IamService, notify } = await freshUnit();
    const { wrapper } = harness();
    const success = vi.spyOn(notify, 'success');

    const { result } = renderHook(() => IamService.IamMutations.useRevokeInvitation(), { wrapper });

    result.current.mutate(INVITATION_ID);

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(success).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledWith({
      id: 'invitation-revoked',
      messageKey: 'members.invitations.revoked',
    });
  });

  /**
   * The half that is an absence.
   *
   * `MutationCache.onError` steps aside for a mutation that declares its own handler
   * (`rules/tanstack-query.mdc` §10). Drop the local `onError` and this refusal reaches the user as
   * a toast **outside** the `aria-modal` dialog that produced it — for a screen-reader user, no
   * signal at all, and for everybody else the second one.
   */
  it.each([
    ['already closed or never there', 'invitation_not_found', 404],
    ['already accepted', 'invitation_already_accepted', 409],
  ])('says nothing through the toaster when the invitation was %s', async (_case, code, status) => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem(code, status)));
    const { IamService, notify } = await freshUnit();
    const { globalNotify, wrapper } = harness();
    const error = vi.spyOn(notify, 'error');

    const { result } = renderHook(() => IamService.IamMutations.useRevokeInvitation(), { wrapper });

    result.current.mutate(INVITATION_ID);

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // The two codes stay distinguishable for the dialog to word them apart (STORY-012-08, D2).
    expect(result.current.error).toMatchObject({ code });
    expect(globalNotify.error).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
