import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { SharedLib } from '@shared';

const { QueryKeys, entityQueryKeys } = SharedLib;

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

describe('invalidation by the group root', () => {
  it('reaches both the list and the detail entries derived from it', async () => {
    const client = new QueryClient();
    const list = QueryKeys.Sessions.list({ page: 2 });
    const detail = QueryKeys.Sessions.detail('session-1');

    client.setQueryData(list, ['stale']);
    client.setQueryData(detail, 'stale');

    await client.invalidateQueries({ queryKey: QueryKeys.Sessions.all });

    expect(client.getQueryState(list)?.isInvalidated).toBe(true);
    expect(client.getQueryState(detail)?.isInvalidated).toBe(true);
  });

  it('leaves another group alone', async () => {
    const client = new QueryClient();
    const foreign = entityQueryKeys<{ page?: number }>('widgets').list({ page: 1 });

    client.setQueryData(foreign, ['kept']);
    await client.invalidateQueries({ queryKey: QueryKeys.Sessions.all });

    expect(client.getQueryState(foreign)?.isInvalidated).toBe(false);
  });
});

/**
 * Compile-time half of the same guarantee, enforced by `tsc -p tsconfig.test.json` rather than by
 * the runner: a `@ts-expect-error` that stops erroring fails `pnpm typecheck` on its own.
 */
describe('the factory is typed', () => {
  it('accepts the parameters the group declares', () => {
    expect(QueryKeys.Sessions.list({ page: 2, perPage: 50 })).toHaveLength(3);
  });

  it('rejects a parameter the group does not declare', () => {
    // @ts-expect-error `sortBy` is not a parameter of the session list
    const key = QueryKeys.Sessions.list({ page: 2, sortBy: 'createdAt' });

    expect(key).toHaveLength(3);
  });

  it('rejects an identifier of the wrong type', () => {
    // @ts-expect-error a detail key is addressed by a string id
    const key = QueryKeys.Sessions.detail(7);

    expect(key).toHaveLength(3);
  });
});
