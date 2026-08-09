import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, SharedLib } from '@shared';

const TEAM_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a41';
const USER_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a52';

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
 * What taking somebody off a team leaves in the query cache.
 *
 * `team-detail.test.tsx` covers the row that was pressed, the wait on that row, and the DELETE that
 * was sent — never the cache. Without invalidation the removed row would stay on screen (a stale
 * `getQueryData` read) until something else happened to refetch it, contradicting the whole point of
 * a pessimistic removal: the composition is only «taken off» once the roster agrees.
 */
describe('taking somebody off the team', () => {
  it('invalidates both the list and the detail the roster reads', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(noContent()));
    const { TeamService } = await freshUnit();
    const { queryClient, wrapper } = harness();

    queryClient.setQueryData(['teams', 'list'], [{ id: TEAM_ID, memberCount: 2 }]);
    queryClient.setQueryData(['teams', 'detail', TEAM_ID], {
      id: TEAM_ID,
      members: [{ userId: USER_ID }],
    });

    const { result } = renderHook(() => TeamService.TeamMutations.useRemoveTeamMember(), {
      wrapper,
    });

    result.current.mutate({ teamId: TEAM_ID, userId: USER_ID });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(queryClient.getQueryState(['teams', 'list'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['teams', 'detail', TEAM_ID])?.isInvalidated).toBe(true);
  });
});
