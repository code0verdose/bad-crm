import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { SharedLib } from '@shared';

const { QueryKeys, entityQueryKeys } = SharedLib;

/** Every filter of the directory, because the group declares them all as required. */
const EMPLOYEE_LIST_PARAMS = {
  q: '',
  status: [],
  role: [],
  team: [],
  sort: 'name',
  page: 2,
  perPage: 50,
} as const satisfies SharedLib.EmployeeListParams;

/**
 * The factory exists because invalidation is silent when it misses.
 *
 * `queryClient.invalidateQueries({ queryKey: ['tasks'] })` matches by prefix, so a hook that spelled
 * its key `['task', id]` keeps serving stale data after a mutation and nothing anywhere reports it —
 * not a type error, not a failing test, not a console warning. The only defence is that every key in
 * the application comes from one typed place (`rules/tanstack-query.mdc` §2).
 */
describe('the shape of a key group', () => {
  it('roots every derived key at the same scope, so a prefix invalidation reaches them all', () => {
    const keys = entityQueryKeys<{ page?: number }>('widgets');

    expect(keys.all).toEqual(['widgets']);
    expect(keys.list({ page: 2 })).toEqual(['widgets', 'list', { page: 2 }]);
    expect(keys.detail('abc')).toEqual(['widgets', 'detail', 'abc']);
  });

  it('puts the parameters in the key, so two filters are two cache entries', () => {
    const keys = entityQueryKeys<{ page?: number }>('widgets');

    expect(keys.list({ page: 1 })).not.toEqual(keys.list({ page: 2 }));
  });
});

/**
 * The employees group stands in for «a group with both shapes», which is what the sentences below
 * are about. It held `Sessions` until STORY-006-04 shipped the session screen and the group had to
 * become what its endpoint actually is — one unpaginated read, no detail. A demonstration of the
 * general shape has to be written over a group that genuinely has that shape.
 */
describe('invalidation by the group root', () => {
  it('reaches both the list and the detail entries derived from it', async () => {
    const client = new QueryClient();
    const list = QueryKeys.Employees.list(EMPLOYEE_LIST_PARAMS);
    const detail = QueryKeys.Employees.detail('employee-1');

    client.setQueryData(list, ['stale']);
    client.setQueryData(detail, 'stale');

    await client.invalidateQueries({ queryKey: QueryKeys.Employees.all });

    expect(client.getQueryState(list)?.isInvalidated).toBe(true);
    expect(client.getQueryState(detail)?.isInvalidated).toBe(true);
  });

  it('leaves another group alone', async () => {
    const client = new QueryClient();
    const foreign = entityQueryKeys<{ page?: number }>('widgets').list({ page: 1 });

    client.setQueryData(foreign, ['kept']);
    await client.invalidateQueries({ queryKey: QueryKeys.Employees.all });

    expect(client.getQueryState(foreign)?.isInvalidated).toBe(false);
  });
});

/**
 * Compile-time half of the same guarantee, enforced by `tsc -p tsconfig.test.json` rather than by
 * the runner: a `@ts-expect-error` that stops erroring fails `pnpm typecheck` on its own.
 */
describe('the factory is typed', () => {
  it('accepts the parameters the group declares', () => {
    expect(QueryKeys.Employees.list(EMPLOYEE_LIST_PARAMS)).toHaveLength(3);
  });

  it('rejects a parameter the group does not declare', () => {
    // @ts-expect-error `sortBy` is not a parameter of the employee directory
    const key = QueryKeys.Employees.list({ ...EMPLOYEE_LIST_PARAMS, sortBy: 'createdAt' });

    expect(key).toHaveLength(3);
  });

  it('rejects an identifier of the wrong type', () => {
    // @ts-expect-error a detail key is addressed by a string id
    const key = QueryKeys.Employees.detail(7);

    expect(key).toHaveLength(3);
  });
});

/**
 * The sessions group, whose `list()` takes no parameters — `GET /auth/sessions` is deliberately
 * unpaginated, one row per signed-in device.
 *
 * Both mutations of the screen (revoke one, revoke the rest) invalidate by the group root, and so
 * does changing a password, which closes every other session as a side effect. All three only reach
 * the list because it starts with that root.
 */
describe('the sessions group', () => {
  it('is reached by invalidating its root, which is what all three writers do', async () => {
    const client = new QueryClient();

    client.setQueryData(QueryKeys.Sessions.list(), { items: [] });
    await client.invalidateQueries({ queryKey: QueryKeys.Sessions.all });

    expect(client.getQueryState(QueryKeys.Sessions.list())?.isInvalidated).toBe(true);
  });

  it('leaves a neighbouring group alone', async () => {
    const client = new QueryClient();

    client.setQueryData(QueryKeys.RecoveryCodes.status(), 'kept');
    await client.invalidateQueries({ queryKey: QueryKeys.Sessions.all });

    expect(client.getQueryState(QueryKeys.RecoveryCodes.status())?.isInvalidated).toBe(false);
  });
});

/**
 * The invitations group, whose `list()` takes no parameters — the operation accepts none.
 *
 * `GET /invitations` has no filter, no page and no order, so a key that carried anything would be a
 * second cache entry for the same bytes; and both mutations of the screen invalidate by the group
 * root, which is only reachable if `list()` starts with it.
 */
describe('the invitations group', () => {
  it('is reached by invalidating its root, which is what both mutations do', async () => {
    const client = new QueryClient();

    client.setQueryData(QueryKeys.Invitations.list(), ['stale']);
    await client.invalidateQueries({ queryKey: QueryKeys.Invitations.all });

    expect(client.getQueryState(QueryKeys.Invitations.list())?.isInvalidated).toBe(true);
  });

  it('leaves a neighbouring group alone', async () => {
    const client = new QueryClient();

    client.setQueryData(QueryKeys.Permissions.mine(), 'kept');
    await client.invalidateQueries({ queryKey: QueryKeys.Invitations.all });

    expect(client.getQueryState(QueryKeys.Permissions.mine())?.isInvalidated).toBe(false);
  });
});
