import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, type SharedLib } from '@shared';

/**
 * Sending an invitation, as the object the widget can render.
 *
 * `InviteMember` used to call `IamMutations.useCreateInvitation()` itself and normalise the form's
 * empty role to `null` itself — the middle link of `rules/frontend-fsd.mdc` rule 4 skipped, and one
 * piece of contract knowledge («no role for now» is `null`, not `''`) sitting in a widget.
 *
 * The minted link is asserted to come back through the hook because it is the one value that exists
 * in exactly one response and can never be fetched again: if the hook dropped it, nothing else could
 * produce it.
 */

const MINTED = {
  id: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a41',
  email: 'colleague@example.test',
  inviteUrl: 'https://crm.example.test/accept/token',
  expiresAt: '2026-09-01T00:00:00.000Z',
  mailDispatched: true,
};

const json = (payload: unknown, status = 201): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

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

  return await import('@units/iam');
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sending an invitation', () => {
  it('CONTROL: turns the empty role into the `null` the contract spells', async () => {
    const calls: Request[] = [];

    vi.stubGlobal('fetch', (input: Request) => {
      calls.push(input.clone());

      return Promise.resolve(json(MINTED));
    });

    const { IamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => IamService.IamHooks.useInvitationDraft(), { wrapper });

    act(() => {
      result.current.send({ email: 'colleague@example.test', roleId: '', locale: 'ru' });
    });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(new URL(String(calls[0]?.url)).pathname).toBe('/api/v1/invitations');
    await expect(calls[0]?.json()).resolves.toEqual({
      email: 'colleague@example.test',
      roleId: null,
      locale: 'ru',
    });
  });

  it('passes a chosen role through untouched', async () => {
    const calls: Request[] = [];

    vi.stubGlobal('fetch', (input: Request) => {
      calls.push(input.clone());

      return Promise.resolve(json(MINTED));
    });

    const { IamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => IamService.IamHooks.useInvitationDraft(), { wrapper });

    act(() => {
      result.current.send({ email: 'a@example.test', roleId: 'role-1', locale: 'en' });
    });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    await expect(calls[0]?.json()).resolves.toMatchObject({ roleId: 'role-1' });
  });

  it('hands the minted link back — the only copy that will ever exist', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json(MINTED)));

    const { IamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => IamService.IamHooks.useInvitationDraft(), { wrapper });

    expect(result.current.minted).toBeUndefined();

    act(() => {
      result.current.send({ email: 'a@example.test', roleId: '', locale: 'en' });
    });

    await waitFor(() => {
      expect(result.current.minted).toMatchObject({ inviteUrl: MINTED.inviteUrl });
    });
  });

  it('leaves a refusal to the one global toast and mints nothing', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem('invitation_already_exists', 409)));

    const { IamService } = await freshUnit();
    const { wrapper, globalNotify } = harness();

    const { result } = renderHook(() => IamService.IamHooks.useInvitationDraft(), { wrapper });

    act(() => {
      result.current.send({ email: 'a@example.test', roleId: '', locale: 'en' });
    });

    await waitFor(() => {
      expect(globalNotify.error).toHaveBeenCalledTimes(1);
    });
    expect(result.current.minted).toBeUndefined();
  });
});
