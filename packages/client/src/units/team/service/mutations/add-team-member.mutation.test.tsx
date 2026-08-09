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
 * What putting somebody on a team leaves in the query cache.
 *
 * `memberCount` on the list row and the roster on the detail screen are the same fact seen from two
 * screens, and both only learn of a new membership through invalidation — the endpoint answers
 * `204`. Neither `team-detail.test.tsx` case that exercises this mutation (`sends the account and
 * the role it was given`, `reports a deactivated account, once`) asserts the cache, so a missing
 * `invalidateQueries` here left the roster showing the old headcount until reload.
 */
describe('putting somebody on the team', () => {
  it('invalidates both the list and the detail the roster reads', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(noContent()));
    const { TeamService } = await freshUnit();
    const { queryClient, wrapper } = harness();

    queryClient.setQueryData(['teams', 'list'], [{ id: TEAM_ID, memberCount: 1 }]);
    queryClient.setQueryData(['teams', 'detail', TEAM_ID], { id: TEAM_ID, members: [] });

    const { result } = renderHook(() => TeamService.TeamMutations.useAddTeamMember(), { wrapper });

    result.current.mutate({ teamId: TEAM_ID, userId: USER_ID, teamRole: 'MEMBER' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(queryClient.getQueryState(['teams', 'list'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['teams', 'detail', TEAM_ID])?.isInvalidated).toBe(true);
  });
});
