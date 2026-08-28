import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, SharedLib } from '@shared';

/**
 * The three writes of the team screen, composed — renaming it, putting somebody on it, taking
 * somebody off.
 *
 * `TeamDetail` called all three mutations itself and mapped the form to the request body itself,
 * which skipped the middle link of `rules/frontend-fsd.mdc` rule 4 in the same way the four
 * confirmation dialogs did. Unlike them it reads no failure — these three controls sit on the page
 * rather than in a modal, so the one global toast is the right signal and the mutations deliberately
 * declare no local `onError` (`add-team-member.mutation.ts` says so in as many words). What moves
 * here is therefore the composition and the mapping, not an error rule.
 *
 * `removingUserId` is the one derived value worth asserting: the wait belongs to the row whose
 * control was pressed, and a shared boolean would spin every row of the roster at once.
 */

const TEAM_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a41';
const USER_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af1';

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

  return await import('@units/team');
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the three writes of a team screen', () => {
  it('CONTROL: renames it with the form mapped to the draft the contract expects', async () => {
    const calls: Request[] = [];

    vi.stubGlobal('fetch', (input: Request) => {
      calls.push(input.clone());

      return Promise.resolve(noContent());
    });

    const { TeamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => TeamService.TeamHooks.useTeamRoster(TEAM_ID), { wrapper });

    act(() => {
      result.current.rename({ name: ' Platform ', slug: ' platform ', description: '  ' });
    });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(new URL(String(calls[0]?.url)).pathname).toBe(`/api/v1/teams/${TEAM_ID}`);
    expect(calls[0]?.method).toBe('PATCH');
    // The mapping is the unit's: trimmed, and an empty description is `null` rather than `''`.
    await expect(calls[0]?.json()).resolves.toEqual({
      name: 'Platform',
      slug: 'platform',
      description: null,
    });
  });

  it('puts somebody on the team with the role the picker chose', async () => {
    const calls: Request[] = [];

    vi.stubGlobal('fetch', (input: Request) => {
      calls.push(input.clone());

      return Promise.resolve(noContent());
    });

    const { TeamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => TeamService.TeamHooks.useTeamRoster(TEAM_ID), { wrapper });

    act(() => {
      result.current.add(USER_ID, 'LEAD');
    });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(new URL(String(calls[0]?.url)).pathname).toBe(`/api/v1/teams/${TEAM_ID}/members`);
    await expect(calls[0]?.json()).resolves.toEqual({ userId: USER_ID, teamRole: 'LEAD' });
  });

  it('names the row it is removing, so the wait belongs to that row and not to the table', async () => {
    let release: (() => void) | undefined;

    vi.stubGlobal(
      'fetch',
      () =>
        new Promise<Response>((resolve) => {
          release = () => {
            resolve(noContent());
          };
        }),
    );

    const { TeamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => TeamService.TeamHooks.useTeamRoster(TEAM_ID), { wrapper });

    expect(result.current.removingUserId).toBeUndefined();

    act(() => {
      result.current.remove(USER_ID);
    });

    await waitFor(() => {
      expect(result.current.removingUserId).toBe(USER_ID);
    });

    act(() => {
      release?.();
    });

    await waitFor(() => {
      // Not «still the last id it saw»: a name that outlives the request would keep one row
      // spinning for ever.
      expect(result.current.removingUserId).toBeUndefined();
    });
  });
});
