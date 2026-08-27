import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, type SharedLib } from '@shared';

/**
 * The administrative 2FA reset as the object a dialog can render.
 *
 * The hook exists for one property, and it is architectural rather than behavioural: **`ui` asks
 * the unit, never the mutation.** The dialog used to call
 * `EmployeeService.EmployeeMutations.useResetUserMfa()` itself and turn the `Error` into a sentence
 * key itself, which skipped the middle link of `rules/frontend-fsd.mdc` rule 4 and put the second
 * copy of `error → messageKey` in a widget — the invitation dialog beside it already had the first,
 * inside its unit hook. Two translations of the same thing on two layers is two places for the rule
 * «choose the sentence by `code`, never by `detail`» (`rules/errors-and-toasts.mdc` §10) to be
 * forgotten in.
 *
 * So what is asserted here is the shape the dialog consumes: a **key**, not an `Error`. A dialog
 * that receives an `Error` can still call `errorMessageKey` on it, and the arrangement this file
 * exists to prevent would be back with the suite green.
 */

const USER = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af1';

/** `ResetMfaResult`, as `docs/api/openapi.yaml` declares it. */
const RESULT = {
  userId: USER,
  wasEnabled: true,
  recoveryCodesDeleted: 7,
  sessionsRevoked: 3,
};

const json = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
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

/**
 * `openapi-fetch` captures `globalThis.fetch` when the client module is evaluated, so the stub has
 * to be in place before the import.
 */
const freshUnit = async () => {
  vi.resetModules();

  return await import('@units/employee');
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resetting somebody else’s second factor', () => {
  it('CONTROL: answers with the report the server produced', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json(RESULT)));
    const { EmployeeService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useResetMfa(USER), {
      wrapper,
    });

    expect(result.current.result).toBeUndefined();

    act(() => {
      result.current.resetMfa();
    });

    await waitFor(() => {
      expect(result.current.result).toEqual(RESULT);
    });
    // The report is the signal; nothing is toasted beside it (`rules/errors-and-toasts.mdc` §2).
    expect(result.current.failureKey).toBeUndefined();
  });

  it('hands the refusal to `ui` as a sentence key rather than as an error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem('user_forbidden', 403)));
    const { EmployeeService } = await freshUnit();
    const { wrapper, globalNotify } = harness();

    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useResetMfa(USER), {
      wrapper,
    });

    act(() => {
      result.current.resetMfa();
    });

    await waitFor(() => {
      expect(result.current.failureKey).toBe('errors.code.user_forbidden');
    });

    // The dialog is `aria-modal`, so the refusal is rendered inside it and the global toast stands
    // aside — one signal for one action (`rules/tanstack-query.mdc` §10).
    expect(globalNotify.error).not.toHaveBeenCalled();
    // Anchored: an unanchored match on the code would be equally happy with a key that has drifted
    // to another namespace (`rules/testing.mdc`, «ассерт по подстроке»).
    expect(result.current.failureKey).toMatch(/^errors\.code\.user_forbidden$/);
  });

  it('forgets the refusal when the dialog is dismissed, so the next open starts clean', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem('user_forbidden', 403)));
    const { EmployeeService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useResetMfa(USER), {
      wrapper,
    });

    act(() => {
      result.current.resetMfa();
    });
    await waitFor(() => {
      expect(result.current.failureKey).toBe('errors.code.user_forbidden');
    });

    act(() => {
      result.current.dismiss();
    });

    await waitFor(() => {
      expect(result.current.failureKey).toBeUndefined();
    });
    expect(result.current.result).toBeUndefined();
  });

  it('forgets the report when the dialog is dismissed', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json(RESULT)));
    const { EmployeeService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useResetMfa(USER), {
      wrapper,
    });

    act(() => {
      result.current.resetMfa();
    });
    await waitFor(() => {
      expect(result.current.result).toEqual(RESULT);
    });

    act(() => {
      result.current.dismiss();
    });

    await waitFor(() => {
      expect(result.current.result).toBeUndefined();
    });
  });

  it('sends the id it was given, and sends it as the path rather than as a body', async () => {
    const calls: Request[] = [];

    vi.stubGlobal('fetch', (input: Request) => {
      calls.push(input);

      return Promise.resolve(json(RESULT));
    });

    const { EmployeeService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useResetMfa(USER), {
      wrapper,
    });

    act(() => {
      result.current.resetMfa();
    });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(new URL(String(calls[0]?.url)).pathname).toBe(`/api/v1/users/${USER}/reset-mfa`);
    expect(calls[0]?.method).toBe('POST');
  });
});
