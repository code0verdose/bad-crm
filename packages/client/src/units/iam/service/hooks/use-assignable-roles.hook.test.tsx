import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi } from '@shared';

/**
 * The roles a screen may name.
 *
 * `widgets/invite-member` and `widgets/invitation-list` each called
 * `IamQueries.useRolesMatrixQuery({ enabled: can('role:read') })` themselves
 * (`rules/frontend-fsd.mdc` rule 4), and the first then built `<select>` options in the component
 * body (rule 5). What is asserted here is the decision both screens were repeating: the read is
 * withheld from a caller who may not be told what the roles are called, and it is withheld rather
 * than attempted and refused.
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

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** `/me/permissions` and `/roles`, routed by path — `useCan` reads the first. */
const server = (held: readonly string[]) => {
  const calls: string[] = [];

  vi.stubGlobal('fetch', (input: Request) => {
    const { pathname } = new URL(String(input.url));

    calls.push(pathname);

    if (pathname.endsWith('/me/permissions')) {
      return Promise.resolve(
        json({ permissions: held, denied: [], roles: [], isOwner: false, version: 1 }),
      );
    }

    return Promise.resolve(
      json({
        items: [
          { id: 'r-1', key: 'manager', name: 'Manager', isSystem: true, permissions: [] },
          { id: 'r-2', key: 'developer', name: 'Developer', isSystem: true, permissions: [] },
        ],
      }),
    );
  });

  return calls;
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

describe('the roles a screen may name', () => {
  it('CONTROL: offers every role, as entries and as options, to a reader who holds `role:read`', async () => {
    server(['role:read']);

    const { IamService } = await freshUnit();
    const { result } = renderHook(() => IamService.IamHooks.useAssignableRoles(), {
      wrapper: harness(),
    });

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(2);
    });
    expect(result.current.options).toEqual([
      { value: 'r-1', label: 'Manager' },
      { value: 'r-2', label: 'Developer' },
    ]);
  });

  it('spends no request on a reader without `role:read`, and offers nothing', async () => {
    const calls = server(['invitation:create']);

    const { IamService } = await freshUnit();
    const { result } = renderHook(() => IamService.IamHooks.useAssignableRoles(), {
      wrapper: harness(),
    });

    await waitFor(() => {
      expect(calls.some((path) => path.endsWith('/me/permissions'))).toBe(true);
    });

    // The negative and its positive control in one assertion: the capability read happened, the
    // roles read did not. Without the first half this would pass on a hook that asks for nothing.
    expect(calls.filter((path) => path.endsWith('/roles'))).toEqual([]);
    expect(result.current.options).toEqual([]);
  });

  it('offers nothing while the capabilities are still unknown', async () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined));

    const { IamService } = await freshUnit();
    const { result } = renderHook(() => IamService.IamHooks.useAssignableRoles(), {
      wrapper: harness(),
    });

    // Fail-closed: `useCan` answers `false` until the answer arrives, so nothing is asked for yet.
    expect(result.current.entries).toEqual([]);
  });
});
