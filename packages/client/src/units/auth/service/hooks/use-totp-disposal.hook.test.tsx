import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, type SharedLib } from '@shared';

/**
 * Turning one's own second factor off, as the object a dialog can render.
 *
 * `DisableTotpDialog` used to call `AuthService.useDisableTotp()` — the mutation, reached through
 * the unit's flat barrel — and turn the `Error` into a sentence key itself. What is asserted here is
 * the shape the dialog now consumes: the two fields in, a **key** out, and `onDisabled` only on the
 * outcome that actually removes the factor.
 *
 * The hook is `useTotpDisposal` rather than `useDisableTotp` because `units/auth` re-exports
 * `service/hooks` and `service/mutations` into one flat namespace: two exports of that name would be
 * one export, chosen by file order.
 */

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

  return await import('@units/auth');
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('turning the second factor off', () => {
  it('CONTROL: sends both proofs as the body the contract expects', async () => {
    const calls: Request[] = [];

    vi.stubGlobal('fetch', (input: Request) => {
      calls.push(input.clone());

      return Promise.resolve(noContent());
    });

    const { AuthService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => AuthService.useTotpDisposal(), { wrapper });

    act(() => {
      result.current.disable({ password: 'correct horse', code: '123456' });
    });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(new URL(String(calls[0]?.url)).pathname).toBe('/api/v1/auth/2fa/disable');
    expect(calls[0]?.method).toBe('POST');
    // Sent as typed: the server decides whether a value is a TOTP code or a recovery code, and
    // nothing on the client inspects it (`disable-totp-form.schema.ts`).
    await expect(calls[0]?.json()).resolves.toEqual({
      password: 'correct horse',
      code: '123456',
    });
  });

  it('runs the callback only once the factor is actually off', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(noContent()));
    const { AuthService } = await freshUnit();
    const { wrapper } = harness();
    const disabled = vi.fn();

    const { result } = renderHook(() => AuthService.useTotpDisposal(), { wrapper });

    act(() => {
      result.current.disable({ password: 'correct horse', code: '123456' }, disabled);
    });

    expect(disabled).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(disabled).toHaveBeenCalledTimes(1);
    });
  });

  it('hands the refusal to `ui` as a sentence key, and keeps the dialog open', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem('reauthentication_required', 403)));
    const { AuthService } = await freshUnit();
    const { wrapper, globalNotify } = harness();
    const disabled = vi.fn();

    const { result } = renderHook(() => AuthService.useTotpDisposal(), { wrapper });

    act(() => {
      result.current.disable({ password: 'wrong', code: '000000' }, disabled);
    });

    await waitFor(() => {
      // Anchored (`rules/testing.mdc`, «ассерт по подстроке»).
      expect(result.current.failure).toEqual({ key: 'errors.code.reauthentication_required' });
    });

    expect(disabled).not.toHaveBeenCalled();
    // The confirmation is `aria-modal`, so the refusal is rendered inside it and the global toast
    // stands aside — one signal for one action (`rules/tanstack-query.mdc` §10).
    expect(globalNotify.error).not.toHaveBeenCalled();
  });

  it('reports nothing refused before anything has been tried', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(noContent()));
    const { AuthService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => AuthService.useTotpDisposal(), { wrapper });

    expect(result.current.failure).toBeUndefined();
    expect(result.current.isPending).toBe(false);
  });
});
