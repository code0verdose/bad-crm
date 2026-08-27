import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, SharedLib, type SharedLib as SharedLibTypes } from '@shared';

/**
 * Bringing one account back, as the object a dialog can render.
 *
 * The behaviour this hook was written for — refresh the personnel record when the report has been
 * **read** rather than when the request succeeded — is proved on the real screen in
 * `test/widgets/reactivation.test.tsx`, which is where a mis-ordering is visible as a report that
 * appears and vanishes. What is proved here is the half that is invisible from a screen: **the
 * dialog is handed a sentence key, not an `Error`.**
 *
 * That is not a detail of taste. Turning a failure into a key means choosing it by `code` and never
 * by `detail` (`rules/errors-and-toasts.mdc` §10), and this product had three confirmation dialogs
 * doing it in three different places — one inside its unit hook, one in the dialog component, one in
 * a dialog that also called the mutation itself. A hook that hands out an `Error` invites the second
 * arrangement back, and nothing would go red: the dialog would simply call `errorMessageKey` again.
 */

const USER = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af1';

/** `ReactivationResult`, as `docs/api/openapi.yaml` declares it. */
const RESULT = {
  userId: USER,
  alreadyActive: false,
  roleIds: [],
};

const json = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
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
  readonly globalNotify: SharedLibTypes.NotificationPort;
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

  return await import('@units/employee');
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bringing an account back', () => {
  it('CONTROL: answers with the report the server produced', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json(RESULT)));
    const { EmployeeService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useReactivation(USER), {
      wrapper,
    });

    act(() => {
      result.current.reactivate();
    });

    await waitFor(() => {
      expect(result.current.result).toEqual(RESULT);
    });
    expect(result.current.failureKey).toBeUndefined();
  });

  it('hands the refusal to `ui` as a sentence key rather than as an error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem('user_forbidden', 403)));
    const { EmployeeService } = await freshUnit();
    const { wrapper, globalNotify } = harness();

    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useReactivation(USER), {
      wrapper,
    });

    act(() => {
      result.current.reactivate();
    });

    await waitFor(() => {
      // Anchored, so a key that drifted into another namespace fails here rather than passing on a
      // substring (`rules/testing.mdc`, «ассерт по подстроке»).
      expect(result.current.failureKey).toMatch(/^errors\.code\.user_forbidden$/);
    });

    // The dialog renders it in place; the global toast stands aside (`rules/tanstack-query.mdc` §10).
    expect(globalNotify.error).not.toHaveBeenCalled();
  });

  it('refreshes the personnel record only once the report has been read', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json(RESULT)));
    const { EmployeeService } = await freshUnit();
    const { wrapper, queryClient } = harness();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useReactivation(USER), {
      wrapper,
    });

    act(() => {
      result.current.reactivate();
    });
    await waitFor(() => {
      expect(result.current.result).toEqual(RESULT);
    });

    // Not on success: the card is drawn only while the account is off, so refreshing here would take
    // the report off the screen in the commit that produced it.
    expect(invalidate).not.toHaveBeenCalled();

    act(() => {
      result.current.dismiss();
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: SharedLib.QueryKeys.Employees.all });
  });

  it('spends nothing on a dismissal that ran nothing', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json(RESULT)));
    const { EmployeeService } = await freshUnit();
    const { wrapper, queryClient } = harness();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useReactivation(USER), {
      wrapper,
    });

    act(() => {
      result.current.dismiss();
    });

    // Cancelling is not an event about the account: a refetch here would redraw what is on screen.
    expect(invalidate).not.toHaveBeenCalled();
  });
});
