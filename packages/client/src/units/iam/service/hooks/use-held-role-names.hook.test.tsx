import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi } from '@shared';

/**
 * What one account's roles are called.
 *
 * `widgets/reactivation/ui/reactivation-roles` called `IamQueries.useUserPermissionsQuery()` itself
 * (`rules/frontend-fsd.mdc` rule 4) and mapped the answer down to names in the component body (rule
 * 5). The three outcomes are asserted separately on purpose: this is a claim about somebody else's
 * power, and «loading» or «refused» folded into «no roles» is a false all-clear on the one screen
 * where a false all-clear matters.
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

const permissions = (...roles: readonly string[]): Response =>
  new Response(
    JSON.stringify({
      userId: USER_ID,
      isOwner: false,
      version: 3,
      roles: roles.map((name, index) => ({
        roleId: `r-${String(index)}`,
        key: name.toLowerCase(),
        name,
      })),
      permissions: [],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

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

describe("naming one account's roles", () => {
  it('CONTROL: names them in the order the answer holds them, unjoined', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(permissions('Administrator', 'Manager')));

    const { IamService } = await freshUnit();
    const { result } = renderHook(() => IamService.IamHooks.useHeldRoleNames(USER_ID), {
      wrapper: harness(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    // A list, not a sentence: turning it into one is `Intl.ListFormat` and a property of the reader.
    expect(result.current.names).toEqual(['Administrator', 'Manager']);
  });

  it('says «pending» rather than «no roles» while the read is in flight', async () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined));

    const { IamService } = await freshUnit();
    const { result } = renderHook(() => IamService.IamHooks.useHeldRoleNames(USER_ID), {
      wrapper: harness(),
    });

    expect(result.current.status).toBe('pending');
    expect(result.current.names).toEqual([]);
  });

  it('says «error» rather than «no roles» when the read is refused', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ type: 'about:blank', title: 'x', status: 403, code: 'forbidden' }),
          { status: 403, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    const { IamService } = await freshUnit();
    const { result } = renderHook(() => IamService.IamHooks.useHeldRoleNames(USER_ID), {
      wrapper: harness(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.names).toEqual([]);
  });

  it('says «success» with nothing in it for an account that holds no role', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(permissions()));

    const { IamService } = await freshUnit();
    const { result } = renderHook(() => IamService.IamHooks.useHeldRoleNames(USER_ID), {
      wrapper: harness(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    // The fourth outcome, and the one the other three must not be confused with.
    expect(result.current.names).toEqual([]);
  });
});
