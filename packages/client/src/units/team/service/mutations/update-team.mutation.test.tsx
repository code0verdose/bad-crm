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
 * What renaming a team leaves in the query cache.
 *
 * `PATCH /teams/{teamId}` answers `204` — there is no document to write into the cache, so
 * invalidation is the *only* mechanism by which the roster header and the list row learn the new
 * name. Every existing case (`team-detail.test.tsx`) asserts the request body and stops there;
 * deleting `queryClient.invalidateQueries` from `useUpdateTeam` left every one of them green while
 * a renamed team kept showing its old name until the page was reloaded.
 */
describe('renaming a team', () => {
  it('invalidates both the list and the detail the roster reads', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(noContent()));
    const { TeamService } = await freshUnit();
    const { queryClient, wrapper } = harness();

    queryClient.setQueryData(['teams', 'list'], [{ id: TEAM_ID, name: 'Backend' }]);
    queryClient.setQueryData(['teams', 'detail', TEAM_ID], { id: TEAM_ID, name: 'Backend' });

    const { result } = renderHook(() => TeamService.TeamMutations.useUpdateTeam(), { wrapper });

    result.current.mutate({
      teamId: TEAM_ID,
      draft: { name: 'Platform', slug: 'backend', description: null },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(queryClient.getQueryState(['teams', 'list'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['teams', 'detail', TEAM_ID])?.isInvalidated).toBe(true);
  });
});
