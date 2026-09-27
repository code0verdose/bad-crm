import { type QueryClient, type QueryKey } from '@tanstack/react-query';

/**
 * Optimistic updates, written once so that no mutation writes its own rollback.
 *
 * Applies to toggles, inline edits, deletes and drag-and-drop — the actions where waiting for the
 * server is the whole cost of the interaction. It does **not** apply to creation (the object has no
 * real id yet, so every link into it goes nowhere) and it never applies inside the vault
 * (`rules/tanstack-query.mdc` §6-§7, §14).
 *
 * The order below is the rule, not a preference: snapshot, then patch, then start the cancellation —
 * all three synchronously, before the caller can await anything. An `await cancelQueries()` in front
 * of the snapshot is the classic race: a refetch already in flight lands during the await, the
 * snapshot records the server's answer instead of what the user was looking at, and the rollback
 * then "restores" a state that never existed on screen (`rules/tanstack-query.mdc` §8).
 */
export interface OptimisticContext {
  /** Every touched entry with the value it held before the patch. */
  readonly snapshots: readonly (readonly [QueryKey, unknown])[];
}

interface Identified {
  readonly id: string;
}

/** The field a row is addressed by. `id` by default; a membership is addressed by `userId`. */
const DEFAULT_ID_KEY = 'id';

const idOf = (item: unknown, idKey: string): unknown => (isRecord(item) ? item[idKey] : undefined);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Applies `map` to whichever collection of entities a cache entry holds, and returns the entry
 * untouched when it holds none.
 *
 * Three shapes reach this cache and a helper that knows one of them silently does nothing for the
 * others — the mutation reads as optimistic in review and is not one in the browser. The envelopes
 * are the ones `docs/api/openapi.yaml` publishes: `{ items, total, page, perPage }` for a table and
 * a page of the same inside `pages` for an infinite query, plus the bare array a `select` produces.
 */
const mapEntities = (
  entry: unknown,
  map: (items: readonly Identified[]) => Identified[],
): unknown => {
  if (Array.isArray(entry)) return map(entry as readonly Identified[]);

  if (!isRecord(entry)) return entry;

  const pages = entry['pages'];
  if (Array.isArray(pages)) {
    return { ...entry, pages: pages.map((page) => mapEntities(page, map)) };
  }

  const items = entry['items'];
  if (Array.isArray(items)) {
    return { ...entry, items: map(items as readonly Identified[]) };
  }

  return entry;
};

const patchEntry = <T extends object>(
  entry: unknown,
  itemId: string,
  patch: Partial<T>,
  idKey: string,
): unknown => {
  const mapped = mapEntities(entry, (items) =>
    items.map((item) => (idOf(item, idKey) === itemId ? { ...item, ...patch } : item)),
  );

  // A collection was recognised and rewritten; the identity check is what tells the two apart.
  if (mapped !== entry) return mapped;

  // Otherwise the entry may be the entity itself, held under a detail key.
  if (isRecord(entry) && entry[idKey] === itemId) return { ...entry, ...patch };

  return entry;
};

const snapshotAndApply = (
  client: QueryClient,
  queryKeys: readonly QueryKey[],
  apply: (entry: unknown) => unknown,
): OptimisticContext => {
  const snapshots: (readonly [QueryKey, unknown])[] = [];

  for (const queryKey of queryKeys) snapshots.push(...client.getQueriesData({ queryKey }));
  for (const queryKey of queryKeys) client.setQueriesData({ queryKey }, apply);
  // Fire-and-forget on purpose: the abort is queued synchronously, and awaiting it here is exactly
  // the race described above.
  for (const queryKey of queryKeys) void client.cancelQueries({ queryKey });

  return { snapshots };
};

export interface OptimisticPatchOptions<T extends object> {
  readonly queryKeys: readonly QueryKey[];
  readonly itemId: string;
  readonly patch: Partial<T>;
  /**
   * The field `itemId` is compared with. A membership has no `id` of its own — it is addressed by
   * the `userId` it belongs to — and a patch aimed at `id` would match nothing and change nothing.
   */
  readonly idKey?: string;
}

export const runOptimisticPatch = <T extends object = Record<string, unknown>>(
  client: QueryClient,
  options: OptimisticPatchOptions<T>,
): OptimisticContext =>
  snapshotAndApply(client, options.queryKeys, (entry) =>
    patchEntry<T>(entry, options.itemId, options.patch, options.idKey ?? DEFAULT_ID_KEY),
  );

export interface OptimisticRemoveOptions {
  readonly queryKeys: readonly QueryKey[];
  readonly itemId: string;
  /** As on the patch: the field `itemId` is compared with, `id` unless said otherwise. */
  readonly idKey?: string;
}

export const runOptimisticRemove = (
  client: QueryClient,
  options: OptimisticRemoveOptions,
): OptimisticContext =>
  snapshotAndApply(client, options.queryKeys, (entry) =>
    mapEntities(entry, (items) =>
      items.filter((item) => idOf(item, options.idKey ?? DEFAULT_ID_KEY) !== options.itemId),
    ),
  );

/**
 * Restores the snapshot rather than undoing the edit.
 *
 * Undoing is where the visible bug lives: a delete rolled back by appending the row puts it at the
 * end of the list instead of back where it was, and the list reorders itself under the user's
 * cursor. Restoring the value that was captured cannot get the position wrong.
 *
 * Tolerates a missing context, which is what `onError` receives when `onMutate` never ran.
 */
export const rollbackOptimistic = (
  client: QueryClient,
  context: OptimisticContext | undefined,
): void => {
  if (context === undefined) return;

  for (const [queryKey, snapshot] of context.snapshots) client.setQueryData(queryKey, snapshot);
};
