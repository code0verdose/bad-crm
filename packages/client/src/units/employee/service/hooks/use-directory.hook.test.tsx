import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi } from '@shared';

/**
 * The directory as a lookup table for screens that are about something else.
 *
 * Both `widgets/team-detail` and `widgets/invitation-list` used to call
 * `EmployeeQueries.useEmployeeListQuery(DIRECTORY, …)` themselves, each carrying its own copy of the
 * paging parameters — the middle link of `rules/frontend-fsd.mdc` rule 4 skipped, twice, over a read
 * neither screen owns. What is asserted here is the part both callers depend on and neither could
 * see: that the request is actually withheld when it may not be made, and that «nobody answered» is
 * distinguishable from «the answer was empty».
 */

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

const page = (...items: readonly { userId: string; firstName: string }[]): Response =>
  new Response(
    JSON.stringify({
      items: items.map((item) => ({
        userId: item.userId,
        email: `${item.firstName.toLowerCase()}@example.test`,
        firstName: item.firstName,
        lastName: 'Doe',
        jobTitle: null,
        department: null,
        status: 'ACTIVE',
        managerId: null,
        roles: [],
        teams: [],
      })),
      page: 1,
      perPage: 100,
      total: items.length,
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

describe('the directory as a lookup table', () => {
  it('CONTROL: asks for the whole first page, sorted by name, when it may', async () => {
    const calls: Request[] = [];

    vi.stubGlobal('fetch', (input: Request) => {
      calls.push(input);

      return Promise.resolve(page({ userId: 'u-1', firstName: 'Ada' }));
    });

    const { EmployeeService } = await freshUnit();
    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useDirectory(true), {
      wrapper: harness(),
    });

    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });
    expect(result.current.people.map((person) => person.userId)).toEqual(['u-1']);

    const url = new URL(String(calls[0]?.url));

    expect(url.pathname).toBe('/api/v1/employees');
    // The three parameters that make this one cache entry rather than a search.
    expect(url.searchParams.get('perPage')).toBe('100');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('sort')).toBe('name');
  });

  it('spends no request at all when the caller may not be told', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(page()));

    vi.stubGlobal('fetch', fetchSpy);

    const { EmployeeService } = await freshUnit();
    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useDirectory(false), {
      wrapper: harness(),
    });

    // A request certain to be refused is not a graceful fallback, it is a 403 per page view.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.people).toEqual([]);
    expect(result.current.isLoaded).toBe(false);
  });

  it('separates «nobody answered» from «the answer was empty»', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(page()));

    const { EmployeeService } = await freshUnit();
    const { result } = renderHook(() => EmployeeService.EmployeeHooks.useDirectory(true), {
      wrapper: harness(),
    });

    await waitFor(() => {
      // An organization of one has nobody to add; a reader who may not be told has nobody to
      // *offer*, and only the second is a reason to withhold the control.
      expect(result.current.isLoaded).toBe(true);
    });
    expect(result.current.people).toEqual([]);
  });
});
