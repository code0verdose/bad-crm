import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, type SharedLib } from '@shared';

/**
 * Creating a team, as the object a dialog can render.
 *
 * `TeamCreateDialog` used to call `TeamMutations.useCreateTeam()` itself, map the form to the
 * request body itself and turn the `Error` into a sentence key itself — the middle link of
 * `rules/frontend-fsd.mdc` rule 4 skipped, and both the mapping and the failure rule living in a
 * widget. What is asserted here is the shape the dialog now consumes: form values in, a **key**
 * out, and the body the contract expects in between.
 */

const TEAM = {
  id: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a41',
  name: 'Backend',
  slug: 'backend',
  description: null,
  memberCount: 0,
};

const json = (payload: unknown, status = 201): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

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

describe('creating a team', () => {
  it('CONTROL: sends the form as the draft the contract expects', async () => {
    const calls: Request[] = [];

    vi.stubGlobal('fetch', (input: Request) => {
      calls.push(input.clone());

      return Promise.resolve(json(TEAM));
    });

    const { TeamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => TeamService.TeamHooks.useTeamCreation(), { wrapper });

    act(() => {
      // Padded, and with an empty description: the mapping to `null` and the trims belong to the
      // unit now (`to-team-draft.util.ts` says why `''` is not an empty description).
      result.current.create({ name: '  Backend  ', slug: ' backend ', description: '   ' });
    });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(new URL(String(calls[0]?.url)).pathname).toBe('/api/v1/teams');
    expect(calls[0]?.method).toBe('POST');
    await expect(calls[0]?.json()).resolves.toEqual({
      name: 'Backend',
      slug: 'backend',
      description: null,
    });
  });

  it('runs the callback only once the server has agreed', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json(TEAM)));
    const { TeamService } = await freshUnit();
    const { wrapper } = harness();
    const created = vi.fn();

    const { result } = renderHook(() => TeamService.TeamHooks.useTeamCreation(), { wrapper });

    act(() => {
      result.current.create({ name: 'Backend', slug: 'backend', description: '' }, created);
    });

    expect(created).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(created).toHaveBeenCalledTimes(1);
    });
  });

  it('hands the refusal to `ui` as a sentence key, and leaves the dialog open', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem('team_already_exists', 409)));
    const { TeamService } = await freshUnit();
    const { wrapper, globalNotify } = harness();
    const created = vi.fn();

    const { result } = renderHook(() => TeamService.TeamHooks.useTeamCreation(), { wrapper });

    act(() => {
      result.current.create({ name: 'Backend', slug: 'backend', description: '' }, created);
    });

    await waitFor(() => {
      // Anchored (`rules/testing.mdc`, «ассерт по подстроке»).
      expect(result.current.failureKey).toMatch(/^errors\.code\.team_already_exists$/);
    });

    expect(created).not.toHaveBeenCalled();
    // The dialog is `aria-modal`, so the refusal is rendered inside it and the global toast stands
    // aside — one signal for one action (`rules/tanstack-query.mdc` §10).
    expect(globalNotify.error).not.toHaveBeenCalled();
  });

  it('forgets the refusal when the dialog is dismissed, so the next open starts clean', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem('team_already_exists', 409)));
    const { TeamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => TeamService.TeamHooks.useTeamCreation(), { wrapper });

    act(() => {
      result.current.create({ name: 'Backend', slug: 'backend', description: '' });
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
