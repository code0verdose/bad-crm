import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, type SharedLib } from '@shared';

/**
 * Saving a personnel record, as the object the page can render.
 *
 * `EmployeeProfilePage` used to call `EmployeeMutations.useUpdateEmployeeProfile()` itself and pair
 * the form's values with the `userId` from the route inside the JSX — the middle link of
 * `rules/frontend-fsd.mdc` rule 4 skipped, on the one layer where it is easiest to excuse because a
 * page «is just composition». It is composition of a **hook**, not of a mutation.
 *
 * Binding the id once, at the top, is the part worth asserting: the page can no longer save one
 * person's form onto another person's record by handing the wrong id at the call site, because
 * there is no id at the call site any more.
 */

const PROFILE = {
  userId: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a41',
  email: 'colleague@example.test',
  fullName: 'Ada Lovelace',
  position: 'Engineer',
};

const json = (payload: unknown, status = 200): Response =>
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

  return await import('@units/employee');
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('editing a personnel record', () => {
  it('CONTROL: sends the patch to the record the hook was bound to', async () => {
    const calls: Request[] = [];

    vi.stubGlobal('fetch', (input: Request) => {
      calls.push(input.clone());

      return Promise.resolve(json(PROFILE));
    });

    const { EmployeeService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(
      () => EmployeeService.EmployeeHooks.useEmployeeProfileEditor(PROFILE.userId),
      { wrapper },
    );

    act(() => {
      result.current.save({ position: 'Staff Engineer' });
    });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(new URL(String(calls[0]?.url)).pathname).toBe(`/api/v1/employees/${PROFILE.userId}`);
    await expect(calls[0]?.json()).resolves.toEqual({ position: 'Staff Engineer' });
  });

  it('reports the wait so the form can disable its own button', async () => {
    let release: (() => void) | undefined;
    vi.stubGlobal(
      'fetch',
      () =>
        new Promise<Response>((resolve) => {
          release = () => {
            resolve(json(PROFILE));
          };
        }),
    );

    const { EmployeeService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(
      () => EmployeeService.EmployeeHooks.useEmployeeProfileEditor(PROFILE.userId),
      { wrapper },
    );

    expect(result.current.isSaving).toBe(false);

    act(() => {
      result.current.save({ position: 'Staff Engineer' });
    });

    await waitFor(() => {
      expect(result.current.isSaving).toBe(true);
    });

    act(() => {
      release?.();
    });

    await waitFor(() => {
      expect(result.current.isSaving).toBe(false);
    });
  });

  it('leaves a refusal to the one global toast', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem('validation_failed', 422)));

    const { EmployeeService } = await freshUnit();
    const { wrapper, globalNotify } = harness();

    const { result } = renderHook(
      () => EmployeeService.EmployeeHooks.useEmployeeProfileEditor(PROFILE.userId),
      { wrapper },
    );

    act(() => {
      result.current.save({ position: '' });
    });

    await waitFor(() => {
      expect(globalNotify.error).toHaveBeenCalledTimes(1);
    });
    expect(globalNotify.success).not.toHaveBeenCalled();
  });
});
