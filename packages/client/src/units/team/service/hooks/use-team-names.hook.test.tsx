import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi } from '@shared';

/**
 * Naming teams by their identifiers.
 *
 * `widgets/invitation-list/ui/invitation-teams` used to call `TeamQueries.useTeamListQuery()` itself
 * and build the lookup in the component body — the middle link of `rules/frontend-fsd.mdc` rule 4
 * skipped, and a `Map` over a query result where rule 5 allows only markup and hook calls. What is
 * asserted here is the behaviour the cell now consumes, including the two cases the cell used to be
 * responsible for: an id the answer does not carry, and no answer at all.
 */

const ALPHA = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a41';
const BETA = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a42';
const GONE = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a99';

const teams = (...entries: readonly { id: string; name: string }[]): Response =>
  new Response(
    JSON.stringify({
      items: entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        slug: entry.name.toLowerCase(),
        description: null,
        memberCount: 1,
        createdAt: '2026-08-01T00:00:00.000Z',
      })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const wrapperOf = (
  queryClient: QueryClient,
): ((props: { readonly children: ReactNode }) => ReactNode) =>
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

const harness = () =>
  wrapperOf(
    SharedApi.createAppQueryClient({
      notify: { error: vi.fn(), success: vi.fn() },
      logError: vi.fn(),
    }),
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

describe('naming the teams of one thing', () => {
  it('CONTROL: names the ids it was asked about, and no others', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(teams({ id: ALPHA, name: 'Alpha' }, { id: BETA, name: 'Beta' })),
    );

    const { TeamService } = await freshUnit();
    const { result } = renderHook(() => TeamService.TeamHooks.useTeamNames([ALPHA]), {
      wrapper: harness(),
    });

    await waitFor(() => {
      expect(result.current).toEqual([{ id: ALPHA, name: 'Alpha' }]);
    });
  });

  it('keeps the order it was given, not the order of the directory', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(teams({ id: ALPHA, name: 'Alpha' }, { id: BETA, name: 'Beta' })),
    );

    const { TeamService } = await freshUnit();
    const { result } = renderHook(() => TeamService.TeamHooks.useTeamNames([BETA, ALPHA]), {
      wrapper: harness(),
    });

    await waitFor(() => {
      expect(result.current.map((team) => team.name)).toEqual(['Beta', 'Alpha']);
    });
  });

  it('drops an id the answer does not carry rather than showing it', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(teams({ id: ALPHA, name: 'Alpha' })));

    const { TeamService } = await freshUnit();
    const { result } = renderHook(() => TeamService.TeamHooks.useTeamNames([ALPHA, GONE]), {
      wrapper: harness(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });
    // The whole point: a UUID in a table cell is noise a person has to ignore (STORY-012-08, D1).
    expect(JSON.stringify(result.current)).not.toContain(GONE);
  });

  it('names nothing while the read is in flight', async () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined));

    const { TeamService } = await freshUnit();
    const { result } = renderHook(() => TeamService.TeamHooks.useTeamNames([ALPHA]), {
      wrapper: harness(),
    });

    expect(result.current).toEqual([]);
  });

  it('names nothing when the read is refused, instead of falling back to ids', async () => {
    vi.stubGlobal(
      'fetch',
      () =>
        new Promise<Response>((resolve) => {
          resolve(
            new Response(
              JSON.stringify({ type: 'about:blank', title: 'x', status: 403, code: 'forbidden' }),
              { status: 403, headers: { 'content-type': 'application/problem+json' } },
            ),
          );
        }),
    );

    const { TeamService } = await freshUnit();
    const { result } = renderHook(() => TeamService.TeamHooks.useTeamNames([ALPHA]), {
      wrapper: harness(),
    });

    await waitFor(() => {
      expect(result.current).toEqual([]);
    });
  });
});
