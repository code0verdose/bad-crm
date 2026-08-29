import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi } from '@shared';

/**
 * One team as a screen renders it.
 *
 * `widgets/team-detail` called `TeamQueries.useTeamDetailQuery()` itself
 * (`rules/frontend-fsd.mdc` rule 4) and kept its own copy of the two-booleans-to-three-states
 * mapping in a helper beside the component. What is asserted here is that mapping — including the
 * case it exists for: a refetch triggered by a membership change must not put a skeleton over rows
 * that are already on screen.
 */

const TEAM_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a41';

const wrapperOf = (
  queryClient: QueryClient,
): ((props: { readonly children: ReactNode }) => ReactNode) =>
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

const harness = (queryClient: QueryClient) => wrapperOf(queryClient);

const freshClient = () =>
  SharedApi.createAppQueryClient({
    notify: { error: vi.fn(), success: vi.fn() },
    logError: vi.fn(),
  });

const team = (): Response =>
  new Response(
    JSON.stringify({
      id: TEAM_ID,
      name: 'Alpha',
      slug: 'alpha',
      description: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      members: [{ userId: 'u-1', teamRole: 'LEAD', joinedAt: '2026-08-01T00:00:00.000Z' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const freshUnit = async () => {
  vi.resetModules();

  return await import('@units/team');
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('one team', () => {
  it('CONTROL: pending until the team arrives, then success with it', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(team()));

    const { TeamService } = await freshUnit();
    const { result } = renderHook(() => TeamService.TeamHooks.useTeamDetail(TEAM_ID), {
      wrapper: harness(freshClient()),
    });

    expect(result.current.status).toBe('pending');
    expect(result.current.team).toBeUndefined();

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.team?.name).toBe('Alpha');
  });

  it('stays «success» *while* a refetch is in flight, so the roster is not replaced by a skeleton', async () => {
    /**
     * The second answer never arrives, and that is the whole point.
     *
     * An awaited `invalidateQueries` proves nothing here: by the time it resolves the refetch is
     * over and `isFetching` is false again, so the assertion passes on `isFetching` as happily as
     * on `isPending` — which is exactly what happened when this test was first written. The state
     * being asserted only exists *during* the refetch, so the refetch is made to last.
     */
    let inFlight = 0;

    vi.stubGlobal('fetch', () => {
      inFlight += 1;

      return inFlight === 1 ? Promise.resolve(team()) : new Promise<Response>(() => undefined);
    });

    const queryClient = freshClient();
    const { TeamService } = await freshUnit();
    const { result } = renderHook(() => TeamService.TeamHooks.useTeamDetail(TEAM_ID), {
      wrapper: harness(queryClient),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    // Adding or removing a member invalidates this key. Not awaited: the assertion belongs to the
    // window the await would close.
    void queryClient.invalidateQueries();

    await waitFor(() => {
      expect(inFlight).toBe(2);
    });

    // `isPending` rather than `isFetching`: a skeleton over rows already on screen is a flash after
    // every single click.
    expect(result.current.status).toBe('success');
    expect(result.current.team?.name).toBe('Alpha');
  });

  it('reports a refused read as an error, with no team', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ type: 'about:blank', title: 'x', status: 404, code: 'team_not_found' }),
          { status: 404, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    const { TeamService } = await freshUnit();
    const { result } = renderHook(() => TeamService.TeamHooks.useTeamDetail(TEAM_ID), {
      wrapper: harness(freshClient()),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.team).toBeUndefined();
  });

  it('asks again on demand', async () => {
    const calls: string[] = [];

    vi.stubGlobal('fetch', (input: Request) => {
      calls.push(String(input.url));

      return Promise.resolve(team());
    });

    const { TeamService } = await freshUnit();
    const { result } = renderHook(() => TeamService.TeamHooks.useTeamDetail(TEAM_ID), {
      wrapper: harness(freshClient()),
    });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    result.current.refetch();

    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
  });
});
