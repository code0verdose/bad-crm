import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, SharedLib } from '@shared';

const TEAM_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a41';

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

const freshUnit = async () => {
  vi.resetModules();

  return import('@units/team');
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * What disbanding a team leaves in the query cache.
 *
 * The screen leaves for `/admin/teams` right after this resolves (`team-detail.test.tsx` → «sends
 * the disbanding and leaves for the list»), which is exactly why no existing case would notice the
 * invalidation going missing: the list route mounts a query that has never run before, so it fetches
 * regardless of whether anything was invalidated. The disbanded team would only linger for somebody
 * who had the list open in a second tab — which this asserts directly, on the cache, rather than by
 * arranging two tabs in a component test.
 */
describe('disbanding a team', () => {
  it('invalidates the team group so a stale row does not linger elsewhere', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(noContent()));
    const { TeamService } = await freshUnit();
    const { queryClient, wrapper } = harness();

    queryClient.setQueryData(['teams', 'list'], [{ id: TEAM_ID, name: 'Backend' }]);

    const { result } = renderHook(() => TeamService.TeamMutations.useDeleteTeam(), { wrapper });

    result.current.mutate(TEAM_ID);

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(queryClient.getQueryState(['teams', 'list'])?.isInvalidated).toBe(true);
  });
});
