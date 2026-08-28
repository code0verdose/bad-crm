import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, type SharedLib } from '@shared';

/**
 * Disbanding a team, as the object a dialog can render.
 *
 * `TeamDeleteDialog` used to call `TeamMutations.useDeleteTeam()` itself and turn the `Error` into a
 * sentence key itself — the middle link of `rules/frontend-fsd.mdc` rule 4 skipped, and the failure
 * rule applied in a widget. What is asserted here is the shape the dialog now consumes: a **key**,
 * not an `Error`, and a callback that fires only when the team is actually gone.
 */

const TEAM_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a41';

const noContent = (): Response => new Response(null, { status: 204 });

/** `application/problem+json` as the server produces it — `code` is the only field the UI reads. */
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
  /** Spied rather than silenced: a silent port would make «no toast» true by construction. */
  readonly globalNotify: SharedLib.NotificationPort;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

const harness = (): Harness => {
  const globalNotify = { error: vi.fn(), success: vi.fn() };
  const queryClient = SharedApi.createAppQueryClient({ notify: globalNotify, logError: vi.fn() });

  return {
    queryClient,
    globalNotify,
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

describe('disbanding a team', () => {
  it('CONTROL: sends the id it was built with, as the path', async () => {
    const calls: Request[] = [];

    vi.stubGlobal('fetch', (input: Request) => {
      calls.push(input);

      return Promise.resolve(noContent());
    });

    const { TeamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => TeamService.TeamHooks.useTeamDeletion(TEAM_ID), {
      wrapper,
    });

    act(() => {
      result.current.disband();
    });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(new URL(String(calls[0]?.url)).pathname).toBe(`/api/v1/teams/${TEAM_ID}`);
    expect(calls[0]?.method).toBe('DELETE');
  });

  it('runs the callback only once the team is actually gone', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(noContent()));
    const { TeamService } = await freshUnit();
    const { wrapper } = harness();
    const deleted = vi.fn();

    const { result } = renderHook(() => TeamService.TeamHooks.useTeamDeletion(TEAM_ID), {
      wrapper,
    });

    act(() => {
      result.current.disband(deleted);
    });

    // Leaving the screen before the server agreed would strand the operator on a list that still
    // has the team in it.
    expect(deleted).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(deleted).toHaveBeenCalledTimes(1);
    });
  });

  it('hands the refusal to `ui` as a sentence key, and stays on the screen', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem('team_forbidden', 403)));
    const { TeamService } = await freshUnit();
    const { wrapper, globalNotify } = harness();
    const deleted = vi.fn();

    const { result } = renderHook(() => TeamService.TeamHooks.useTeamDeletion(TEAM_ID), {
      wrapper,
    });

    act(() => {
      result.current.disband(deleted);
    });

    await waitFor(() => {
      // Anchored (`rules/testing.mdc`, «ассерт по подстроке»).
      expect(result.current.failureKey).toMatch(/^errors\.code\.team_forbidden$/);
    });

    expect(deleted).not.toHaveBeenCalled();
    // The dialog is `aria-modal`, so the refusal is rendered inside it and the global toast stands
    // aside — one signal for one action (`rules/tanstack-query.mdc` §10).
    expect(globalNotify.error).not.toHaveBeenCalled();
  });

  it('forgets the refusal when the dialog is dismissed, so the next open starts clean', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem('team_forbidden', 403)));
    const { TeamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => TeamService.TeamHooks.useTeamDeletion(TEAM_ID), {
      wrapper,
    });

    act(() => {
      result.current.disband();
    });
    await waitFor(() => {
      expect(result.current.failureKey).toBeDefined();
    });

    act(() => {
      result.current.dismiss();
    });

    await waitFor(() => {
      expect(result.current.failureKey).toBeUndefined();
    });
  });
});
