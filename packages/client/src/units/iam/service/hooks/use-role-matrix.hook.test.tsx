import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi } from '@shared';

/**
 * The administration matrix as one object.
 *
 * `widgets/role-matrix` called `IamQueries.useRolesMatrixQuery()` itself and then bound the draft to
 * the answer — the middle link of `rules/frontend-fsd.mdc` rule 4 skipped on the one screen where
 * the read and the two writes are three views of the same thing. What is asserted here is the
 * binding the widget was doing: that the draft is a draft **of the roles that arrived**, and that
 * the identity it is bound to does not change while nothing has.
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

const roles = (): Response =>
  new Response(
    JSON.stringify({
      items: [
        {
          id: 'r-1',
          key: 'manager',
          name: 'Manager',
          isSystem: false,
          permissions: ['team:read'],
        },
      ],
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

describe('the administration matrix', () => {
  it('CONTROL: hands over the roles and the three states of the read', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(roles()));

    const { IamService } = await freshUnit();
    const { result } = renderHook(() => IamService.IamHooks.useRoleMatrix(), {
      wrapper: harness(),
    });

    expect(result.current.status).toBe('pending');

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.roles.map((role) => role.name)).toEqual(['Manager']);
  });

  it('binds the draft to the roles that arrived, so a toggle is counted', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(roles()));

    const { IamService } = await freshUnit();
    const { result } = renderHook(() => IamService.IamHooks.useRoleMatrix(), {
      wrapper: harness(),
    });

    await waitFor(() => {
      expect(result.current.roles).toHaveLength(1);
    });
    // Before the binding this was the widget's job, and a draft bound to a stale array counts
    // changes against roles that are no longer on screen.
    expect(result.current.draft.changeCount).toBe(0);

    act(() => {
      result.current.draft.toggle('r-1', 'team:update');
    });

    await waitFor(() => {
      expect(result.current.draft.changeCount).toBe(1);
    });
  });

  it('keeps one array identity while nothing has arrived, so the draft is not rebound each render', async () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined));

    const { IamService } = await freshUnit();
    const { result, rerender } = renderHook(() => IamService.IamHooks.useRoleMatrix(), {
      wrapper: harness(),
    });

    const first = result.current.roles;

    rerender();

    // `query.data ?? []` would be a new array here, and the whole catalogue would be regrouped on
    // every keystroke of the search box above to produce the same answer.
    expect(result.current.roles).toBe(first);
  });

  it('reports a failed read as an error, with nothing to edit', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ type: 'about:blank', title: 'x', status: 403, code: 'forbidden' }),
          { status: 403, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    const { IamService } = await freshUnit();
    const { result } = renderHook(() => IamService.IamHooks.useRoleMatrix(), {
      wrapper: harness(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.roles).toEqual([]);
  });
});
