import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, SharedLib } from '@shared';

/**
 * What creating an invitation is allowed to leave behind.
 *
 * The answer carries `inviteUrl` — a single-use link that is the **whole** credential for creating
 * an account in this organization, and the one time it is ever shown. TanStack Query keeps whatever
 * `mutationFn` resolves to in the `MutationCache`, and the cache is not a private corner: the
 * `QueryClient` travels in the router context, and `@tanstack/router-core` assigns
 * `self.__TSR_ROUTER__ = this` for every router built in a document, with no development guard.
 *
 * `gcTime` is counted from the moment the last observer unmounts, so the default five minutes start
 * when the person has already navigated away from the invite screen. This asserts the option as the
 * **observable property** rather than as a line of configuration: nothing of the link remains once
 * the mutation is no longer watched. Deleting `gcTime: 0` has to turn this red.
 */
const ROLE_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af2';
const INVITE_URL = 'https://crm.example.test/invite/single-use-token-value';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const minted = (): Response =>
  json(
    {
      invitation: {
        id: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af5',
        email: 'ivan@example.test',
        roleId: ROLE_ID,
        teamIds: [],
        locale: 'en',
        expiresAt: '2026-08-14T00:00:00.000Z',
        createdAt: '2026-08-07T00:00:00.000Z',
        invitedById: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af6',
      },
      inviteUrl: INVITE_URL,
      mailDispatched: true,
    },
    201,
  );

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

/** Everything the mutation cache is holding, as one string — arguments as well as answers. */
const cacheContents = (queryClient: QueryClient): string =>
  JSON.stringify(
    queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
  );

const freshUnit = async () => {
  vi.resetModules();

  return import('@units/iam');
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('creating an invitation', () => {
  it('CONTROL: hands the link to the caller, so the assertion below is not about an empty answer', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(minted()));
    const { IamService } = await freshUnit();
    const { queryClient, wrapper } = harness();

    const { result } = renderHook(() => IamService.IamMutations.useCreateInvitation(), { wrapper });

    result.current.mutate({ email: 'ivan@example.test', locale: 'en' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.inviteUrl).toBe(INVITE_URL);
    // While the screen is mounted the link is legitimately in the cache — it is on screen.
    expect(cacheContents(queryClient)).toContain(INVITE_URL);
  });

  it('keeps the link out of the cache once nothing is watching', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(minted()));
    const { IamService } = await freshUnit();
    const { queryClient, wrapper } = harness();

    const { result, unmount } = renderHook(() => IamService.IamMutations.useCreateInvitation(), {
      wrapper,
    });

    result.current.mutate({ email: 'ivan@example.test', locale: 'en' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    unmount();

    await waitFor(() => {
      expect(cacheContents(queryClient)).not.toContain(INVITE_URL);
    });
  });
});
