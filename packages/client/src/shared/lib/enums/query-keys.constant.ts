/**
 * The one place a query key is spelled (`rules/tanstack-query.mdc` §2).
 *
 * A key is a cache address, and `invalidateQueries` matches it by prefix. A hook that writes its own
 * `['task', id]` beside a factory that writes `['tasks', 'detail', id]` therefore keeps serving stale
 * data after every mutation — and nothing reports it. Not a type error, not a warning, not a failing
 * test: a screen that is quietly wrong until the user reloads. Centralising the keys is what turns
 * that class of defect into a compile error, and `test/architecture/data-layer-conventions.test.ts`
 * fails the build on a literal array reaching `queryKey`.
 *
 * The hierarchy is fixed: `all` is the prefix every derived key starts with, so one invalidation of
 * a group reaches its lists and its details together.
 */
export interface EntityQueryKeys<TListParams> {
  /** Prefix of the whole group — what a mutation invalidates. */
  readonly all: readonly [string];
  /** One cache entry per distinct filter: the parameters are part of the address. */
  readonly list: (params: TListParams) => readonly [string, 'list', TListParams];
  readonly detail: (id: string) => readonly [string, 'detail', string];
}

export const entityQueryKeys = <TListParams>(scope: string): EntityQueryKeys<TListParams> => ({
  all: [scope],
  list: (params) => [scope, 'list', params],
  detail: (id) => [scope, 'detail', id],
});

/**
 * Offset pagination, as `docs/api/openapi.yaml` publishes it for table-shaped lists. Declared per
 * group rather than shared, because the filters of a group are part of its contract: a parameter
 * the endpoint does not accept has to be a compile error at the call site, not an extra cache entry.
 */
export interface SessionListParams {
  readonly page?: number;
  readonly perPage?: number;
}

/**
 * The registry. A group is added here by the epic that adds the operations behind it — today that is
 * the client session (`units/session`), the reference unit of the tree.
 */
export const QueryKeys = {
  Sessions: entityQueryKeys<SessionListParams>('sessions'),
} as const;
