import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, type SharedLib } from '@shared';

/**
 * Switching a colleague off, as the object a dialog can render.
 *
 * The hook exists for one property, and it is architectural rather than behavioural: **`ui` asks the
 * unit, never the mutation.** `OffboardingDialog` called `EmployeeMutations.useDeactivateUser()`
 * itself and turned the `Error` into a sentence key itself — the middle link of
 * `rules/frontend-fsd.mdc` rule 4 skipped, and a fourth copy of `error → messageKey` sitting in a
 * widget while the three confirmations beside it kept theirs in their units.
 *
 * So what is asserted here is the shape the dialog consumes: a **key**, not an `Error`. A dialog
 * handed an `Error` can call `errorMessageKey` on it again, and the arrangement this file exists to
 * prevent would be back with the suite green.
 */

const USER = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af1';

/** `OffboardingReport`, as `docs/api/openapi.yaml` declares it. */
const REPORT = {
  userId: USER,
  alreadyDeactivated: false,
  sessionsRevoked: 3,
  teamsLeft: 2,
  pending: ['projectsLeft'],
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

describe('switching a colleague off', () => {
  it('CONTROL: answers with the report the server produced', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json(REPORT)));
    const { EmployeeService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useOffboarding(USER), {
      wrapper,
    });

    expect(result.current.report).toBeUndefined();

    act(() => {
      result.current.deactivate('Уволен');
    });

    await waitFor(() => {
      expect(result.current.report).toEqual(REPORT);
    });
    // The report is the signal; nothing is toasted beside it (`rules/errors-and-toasts.mdc` §2).
    expect(result.current.failureKey).toBeUndefined();
  });

  it('hands the refusal to `ui` as a sentence key rather than as an error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem('last_owner_required', 409)));
    const { EmployeeService } = await freshUnit();
    const { wrapper, globalNotify } = harness();

    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useOffboarding(USER), {
      wrapper,
    });

    act(() => {
      result.current.deactivate('Уволен');
    });

    await waitFor(() => {
      // Anchored: an unanchored match on the code would be equally happy with a key that has
      // drifted to another namespace (`rules/testing.mdc`, «ассерт по подстроке»).
      expect(result.current.failureKey).toMatch(/^errors\.code\.last_owner_required$/);
    });

    // The dialog is `aria-modal`, so the refusal is rendered inside it and the global toast stands
    // aside — one signal for one action (`rules/tanstack-query.mdc` §10).
    expect(globalNotify.error).not.toHaveBeenCalled();
  });

  it('forgets both answers when the dialog is dismissed, so the next open starts clean', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem('last_owner_required', 409)));
    const { EmployeeService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useOffboarding(USER), {
      wrapper,
    });

    act(() => {
      result.current.deactivate('Уволен');
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
    expect(result.current.report).toBeUndefined();
  });

  it('sends the id as the path and the trimmed reason as the body', async () => {
    const calls: Request[] = [];

    vi.stubGlobal('fetch', (input: Request) => {
      calls.push(input.clone());

      return Promise.resolve(json(REPORT));
    });

    const { EmployeeService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useOffboarding(USER), {
      wrapper,
    });

    act(() => {
      // Padded on both sides: the trim is the hook's, and the dialog no longer does it on the way
      // in — the request body is the unit's business, not the field's.
      result.current.deactivate('  Уволен  ');
    });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(new URL(String(calls[0]?.url)).pathname).toBe(`/api/v1/users/${USER}/deactivate`);
    expect(calls[0]?.method).toBe('POST');
    await expect(calls[0]?.json()).resolves.toEqual({ reason: 'Уволен' });
  });
});
