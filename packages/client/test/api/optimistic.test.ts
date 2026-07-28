import { QueryClient, type QueryKey } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { rollbackOptimistic, runOptimisticPatch, runOptimisticRemove } from '@shared/api';

interface Row {
  readonly id: string;
  readonly done: boolean;
}

const rows = (): Row[] => [
  { id: 'a', done: false },
  { id: 'b', done: false },
  { id: 'c', done: false },
];

const KEY: QueryKey = ['rows'];

const clientWith = (data: unknown): QueryClient => {
  const client = new QueryClient();
  client.setQueryData(KEY, data);
  return client;
};

/**
 * Four shapes reach the cache in this application and a helper that knows only one of them silently
 * does nothing for the others — the mutation looks optimistic in review and is not one in the
 * browser. The envelope of a table is `{ items, total, page, perPage }` and the envelope of a feed
 * is a page of the same, so both are listed here beside the bare array and the single entity.
 */
describe('patching every cache shape the API produces', () => {
  it.each([
    ['a bare array', rows(), (value: unknown) => value as Row[]],
    [
      'an offset page',
      { items: rows(), total: 3 },
      (value: unknown) => (value as { items: Row[] }).items,
    ],
    [
      'an infinite query',
      { pages: [{ items: rows() }], pageParams: [1] },
      (value: unknown) => (value as { pages: { items: Row[] }[] }).pages[0]?.items ?? [],
    ],
  ])('%s', (_case, data, read) => {
    const client = clientWith(data);

    runOptimisticPatch<Row>(client, { queryKeys: [KEY], itemId: 'b', patch: { done: true } });

    expect(read(client.getQueryData(KEY))).toEqual([
      { id: 'a', done: false },
      { id: 'b', done: true },
      { id: 'c', done: false },
    ]);
  });

  it('a single entity held under a detail key', () => {
    const client = clientWith({ id: 'b', done: false });

    runOptimisticPatch<Row>(client, { queryKeys: [KEY], itemId: 'b', patch: { done: true } });

    expect(client.getQueryData(KEY)).toEqual({ id: 'b', done: true });
  });

  it('leaves a single entity that is not the one being changed untouched', () => {
    const client = clientWith({ id: 'z', done: false });

    runOptimisticPatch<Row>(client, { queryKeys: [KEY], itemId: 'b', patch: { done: true } });

    expect(client.getQueryData(KEY)).toEqual({ id: 'z', done: false });
  });

  it('does nothing to a cache entry that has no data yet', () => {
    const client = clientWith(null);

    runOptimisticPatch<Row>(client, { queryKeys: [KEY], itemId: 'b', patch: { done: true } });

    expect(client.getQueryData(KEY)).toBeNull();
  });
});

describe('removing an item', () => {
  it.each([
    ['a bare array', rows(), (value: unknown) => value as Row[]],
    [
      'an offset page',
      { items: rows(), total: 3 },
      (value: unknown) => (value as { items: Row[] }).items,
    ],
    [
      'an infinite query',
      { pages: [{ items: rows() }], pageParams: [1] },
      (value: unknown) => (value as { pages: { items: Row[] }[] }).pages[0]?.items ?? [],
    ],
  ])('%s', (_case, data, read) => {
    const client = clientWith(data);

    runOptimisticRemove(client, { queryKeys: [KEY], itemId: 'b' });

    expect(read(client.getQueryData(KEY)).map((row) => row.id)).toEqual(['a', 'c']);
  });

  it('leaves a shape it cannot address alone rather than emptying it', () => {
    const client = clientWith({ id: 'b', done: false });

    runOptimisticRemove(client, { queryKeys: [KEY], itemId: 'b' });

    expect(client.getQueryData(KEY)).toEqual({ id: 'b', done: false });
  });

  it('does nothing to a cache entry that has no data yet', () => {
    const client = clientWith(undefined);

    runOptimisticRemove(client, { queryKeys: [KEY], itemId: 'b' });

    expect(client.getQueryData(KEY)).toBeUndefined();
  });
});

/**
 * The ordering rule of `rules/tanstack-query.mdc` §8: the snapshot is taken *before* the patch and
 * *without* awaiting `cancelQueries`. An `await` there is a race — a refetch already in flight can
 * land during it, and the snapshot then records the server's answer instead of the state the user
 * was looking at, so the rollback restores the wrong thing.
 */
describe('the order of operations', () => {
  it('applies the patch synchronously, before the caller can await anything', () => {
    const client = clientWith(rows());

    const context = runOptimisticPatch<Row>(client, {
      queryKeys: [KEY],
      itemId: 'b',
      patch: { done: true },
    });

    expect((client.getQueryData(KEY) as Row[])[1]?.done).toBe(true);
    expect(context.snapshots).toHaveLength(1);
  });

  it('starts the cancellation of background refetches without waiting for it', () => {
    const client = clientWith(rows());
    const cancelQueries = vi.spyOn(client, 'cancelQueries');

    runOptimisticPatch<Row>(client, { queryKeys: [KEY], itemId: 'b', patch: { done: true } });

    expect(cancelQueries).toHaveBeenCalledWith({ queryKey: KEY });
  });
});

describe('rolling back', () => {
  it('restores exactly the state that was snapshotted', () => {
    const client = clientWith(rows());
    const before = client.getQueryData(KEY);

    const context = runOptimisticPatch<Row>(client, {
      queryKeys: [KEY],
      itemId: 'b',
      patch: { done: true },
    });
    rollbackOptimistic(client, context);

    expect(client.getQueryData(KEY)).toEqual(before);
  });

  /**
   * The failure the acceptance of STORY-004-04 names by hand: a rollback that re-adds the removed
   * row by appending it. The row was second; after the server refuses the delete it has to be second
   * again, otherwise the list reorders itself under the user's cursor.
   */
  it('returns a removed item to its position, not to the end of the list', () => {
    const client = clientWith(rows());

    const context = runOptimisticRemove(client, { queryKeys: [KEY], itemId: 'b' });
    rollbackOptimistic(client, context);

    expect((client.getQueryData(KEY) as Row[]).map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op when onMutate never produced a context', () => {
    const client = clientWith(rows());

    rollbackOptimistic(client, undefined);

    expect((client.getQueryData(KEY) as Row[]).map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('a full optimistic mutation', () => {
  const runMutation = async (
    client: QueryClient,
    mutationFn: () => Promise<void>,
  ): Promise<void> => {
    const mutation = client
      .getMutationCache()
      .build<void, Error, void, { snapshots: readonly (readonly [QueryKey, unknown])[] }>(client, {
        mutationFn,
        onMutate: () => runOptimisticRemove(client, { queryKeys: [KEY], itemId: 'b' }),
        onError: (_error, _variables, context) => {
          rollbackOptimistic(client, context);
        },
        onSettled: async () => {
          await client.invalidateQueries({ queryKey: KEY });
        },
      });

    await mutation.execute().catch(() => undefined);
  };

  it('ends on the server state: the row is back and the key is invalidated', async () => {
    const client = clientWith(rows());

    await runMutation(client, () => Promise.reject(new Error('server refused')));

    expect((client.getQueryData(KEY) as Row[]).map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(client.getQueryState(KEY)?.isInvalidated).toBe(true);
  });

  it('keeps the optimistic removal when the server agrees, and still invalidates', async () => {
    const client = clientWith(rows());

    await runMutation(client, () => Promise.resolve());

    expect((client.getQueryData(KEY) as Row[]).map((row) => row.id)).toEqual(['a', 'c']);
    expect(client.getQueryState(KEY)?.isInvalidated).toBe(true);
  });
});
