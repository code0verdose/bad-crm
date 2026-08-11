import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, SharedLib } from '@shared';

/**
 * The two side effects `useWritePermissionOverride` owes on a successful write, neither of which a
 * missing `return`/branch would leave uncovered — both lines execute either way, and only an
 * assertion on their effect can tell a write that succeeds silently from one that actually reports
 * itself (`rules/testing.mdc`, «Тест, который не видели красным», п. 5).
 */

const USER_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af1';
const OTHER_USER_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af9';

const noContent = (): Response => new Response(null, { status: 204 });

interface Harness {
  readonly queryClient: QueryClient;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

const harness = (): Harness => {
  const queryClient = SharedApi.createAppQueryClient({
    notify: SharedLib.silentNotifications,
    logError: vi.fn(),
  });

  return {
    queryClient,
    wrapper: function Wrapper({ children }: { readonly children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    },
  };
};

/**
 * `vi.resetModules()` rebuilds the client's own module graph, `@shared/ui`'s toaster included — so
 * a spy placed on the file's top-level `SharedUi.notify` would watch an object the freshly imported
 * mutation module never touches. Both barrels are therefore re-imported together, from the same
 * fresh graph, the way `startAt` in `test/widgets/user-permissions.test.tsx` does it.
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

describe('writing a permission exception', () => {
  it('CONTROL: succeeds, so the assertions below are not about a failed write', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(noContent()));
    const { IamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => IamService.IamMutations.useWritePermissionOverride(), {
      wrapper,
    });

    result.current.mutate({
      userId: USER_ID,
      permission: 'invoice:issue',
      override: { effect: 'ALLOW', reason: 'covering billing', expiresAt: null },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
  });

  it('reports the success with a toast, rather than settling silently', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(noContent()));
    const { IamService, notify } = await freshUnit();
    const { wrapper } = harness();
    const success = vi.spyOn(notify, 'success');

    const { result } = renderHook(() => IamService.IamMutations.useWritePermissionOverride(), {
      wrapper,
    });

    result.current.mutate({
      userId: USER_ID,
      permission: 'invoice:issue',
      override: { effect: 'ALLOW', reason: 'covering billing', expiresAt: null },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(success).toHaveBeenCalledWith({
      id: 'permission-override',
      messageKey: 'permissions.saved',
    });
  });

  it('invalidates the whole permissions group, including the caller’s own «mine» answer', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(noContent()));
    const { IamService, QueryKeys } = await freshUnit();
    const { queryClient, wrapper } = harness();

    // Seeded under a *different* subject and under `mine()`, so an invalidation scoped to
    // `ofUser(variables.userId)` alone — the regression this pins — would leave both untouched
    // while still reporting success.
    queryClient.setQueryData(QueryKeys.Permissions.mine(), {
      permissions: [],
      denied: [],
      roles: [],
      isOwner: false,
      version: 1,
    });
    queryClient.setQueryData(QueryKeys.Permissions.ofUser(OTHER_USER_ID), {
      userId: OTHER_USER_ID,
      isOwner: false,
      version: 1,
      roles: [],
      permissions: [],
    });

    const { result } = renderHook(() => IamService.IamMutations.useWritePermissionOverride(), {
      wrapper,
    });

    result.current.mutate({
      userId: USER_ID,
      permission: 'invoice:issue',
      override: { effect: 'ALLOW', reason: 'covering billing', expiresAt: null },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(
      queryClient.getQueryState(QueryKeys.Permissions.mine())?.isInvalidated,
      'a self-override changes the caller’s own sidebar and every can(...) in the shell — «mine()» has to be reached',
    ).toBe(true);
    expect(
      queryClient.getQueryState(QueryKeys.Permissions.ofUser(OTHER_USER_ID))?.isInvalidated,
      'the whole group is one prefix, not one subject at a time',
    ).toBe(true);
  });
});
