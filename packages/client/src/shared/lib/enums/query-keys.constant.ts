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
/**
 * The caller's own permissions — one address, because the question takes no parameters.
 *
 * Not `entityQueryKeys`: that shape carries a list and a detail, and this group has neither. There
 * is exactly one answer per signed-in person, and asking about somebody else is a different
 * operation under a different permission (`GET /me/permissions` takes no subject on purpose).
 */
export interface PermissionQueryKeys {
  readonly all: readonly [string];
  readonly mine: () => readonly [string, 'mine'];
}

/**
 * Roles of the organization — the administration matrix reads one address and writes it back.
 *
 * `matrix()` rather than `list(params)`: the screen asks for every role with everything it grants,
 * because it renders them all against every permission at once. There is no filter that would make
 * a second cache entry meaningful, and the filtering the screen does do — search, groups, «only
 * differences» — happens over an answer it already has.
 */
export interface RoleQueryKeys {
  readonly all: readonly [string];
  readonly matrix: () => readonly [string, 'matrix'];
}

/**
 * Personnel records. `entityQueryKeys`, because this group genuinely has both shapes: one record per
 * person (`detail`) and the directory that lists them (`list`, STORY-012-04). Both start with the
 * same prefix, so saving a profile can invalidate the directory with one call.
 */
export interface EmployeeListParams {
  readonly q: string;
  readonly status: readonly string[];
  readonly role: readonly string[];
  readonly team: readonly string[];
  readonly sort: string;
  readonly page: number;
  readonly perPage: number;
}

/**
 * The chart is a third address, not a `list` with a filter.
 *
 * It answers a different question — every edge of the organization, unpaged — behind a different
 * permission, and it does not change when the directory's filters do. Giving it a `list` key would
 * mean a cache entry per filter of a screen whose answer does not depend on any of them.
 */
export interface EmployeeQueryKeys extends EntityQueryKeys<EmployeeListParams> {
  readonly orgChart: () => readonly [string, 'org-chart'];
}

export const QueryKeys = {
  Sessions: entityQueryKeys<SessionListParams>('sessions'),
  Permissions: {
    all: ['permissions'],
    mine: () => ['permissions', 'mine'],
  } satisfies PermissionQueryKeys,
  Roles: {
    all: ['roles'],
    matrix: () => ['roles', 'matrix'],
  } satisfies RoleQueryKeys,
  Employees: {
    ...entityQueryKeys<EmployeeListParams>('employees'),
    orgChart: () => ['employees', 'org-chart'],
  } satisfies EmployeeQueryKeys,
} as const;
