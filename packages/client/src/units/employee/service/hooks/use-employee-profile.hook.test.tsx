import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi } from '@shared';

/**
 * One personnel card: the read, the write and the mapping between them.
 *
 * `pages/employee-profile/page.tsx` used to call `EmployeeQueries.useEmployeeProfileQuery()` itself
 * (`rules/frontend-fsd.mdc` rule 4) and keep the document-to-form mapping in a function declared
 * below the component. What is asserted here is the half the page could not: that a key the server
 * **withheld** is reported as withheld rather than as an empty answer, which is the difference
 * between a disabled field and a save that erases what it could not see.
 */

const USER_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a41';

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

/** The document as the server sends it — `extra` is what a caller with the right also receives. */
const profile = (extra: Record<string, unknown>): Response =>
  new Response(
    JSON.stringify({
      userId: USER_ID,
      email: 'ada@example.test',
      firstName: 'Ada',
      lastName: 'Lovelace',
      jobTitle: null,
      department: null,
      managerId: null,
      timezone: 'Europe/Moscow',
      skills: ['sql', 'ml'],
      ...extra,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

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

describe('one personnel card', () => {
  it('CONTROL: hands the form its fields, joined and defaulted as the form needs them', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(profile({ emergencyContact: '+7 900 000-00-00' })),
    );

    const { EmployeeService } = await freshUnit();
    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useEmployeeProfile(USER_ID), {
      wrapper: harness(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.initialValues).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      jobTitle: '',
      department: '',
      employmentType: 'FULL_TIME',
      weeklyCapacityHours: '40',
      timezone: 'Europe/Moscow',
      // A list in the document, a comma-separated line in the form.
      skills: 'sql, ml',
      emergencyContact: '+7 900 000-00-00',
    });
    expect(result.current.carriesEmergencyContact).toBe(true);
  });

  it('reports a withheld key as withheld, not as an empty value', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(profile({})));

    const { EmployeeService } = await freshUnit();
    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useEmployeeProfile(USER_ID), {
      wrapper: harness(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    // The form still gets a value to render — an enabled field over it would be one save away from
    // erasing what the server withheld, which is what this flag disables.
    expect(result.current.initialValues?.emergencyContact).toBe('');
    expect(result.current.carriesEmergencyContact).toBe(false);
  });

  it('offers no form while there is no document', async () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined));

    const { EmployeeService } = await freshUnit();
    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useEmployeeProfile(USER_ID), {
      wrapper: harness(),
    });

    expect(result.current.status).toBe('pending');
    expect(result.current.initialValues).toBeUndefined();
    expect(result.current.profile).toBeUndefined();
  });

  it('reports a failed read as an error rather than as an empty record', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ type: 'about:blank', title: 'x', status: 404, code: 'user_not_found' }),
          { status: 404, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    const { EmployeeService } = await freshUnit();
    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useEmployeeProfile(USER_ID), {
      wrapper: harness(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.initialValues).toBeUndefined();
  });

  it('saves onto the record it was bound to, and reports the wait', async () => {
    const calls: Request[] = [];

    vi.stubGlobal('fetch', (input: Request) => {
      calls.push(input);

      return input.method === 'PATCH' ? Promise.resolve(profile({})) : Promise.resolve(profile({}));
    });

    const { EmployeeService } = await freshUnit();
    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useEmployeeProfile(USER_ID), {
      wrapper: harness(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    act(() => {
      result.current.save({ jobTitle: 'Analyst' });
    });

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'PATCH')).toBe(true);
    });
    // The id is bound once, here: there is no id at the call site to get wrong.
    expect(new URL(String(calls.find((call) => call.method === 'PATCH')?.url)).pathname).toBe(
      `/api/v1/employees/${USER_ID}`,
    );
  });
});
