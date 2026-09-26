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
 * The caller's own live sessions — a `list()` that takes no parameters, because the operation takes
 * none.
 *
 * `GET /auth/sessions` is deliberately unpaginated (`docs/api/openapi.yaml`, `listSessions`: one row
 * per signed-in device, capped by a thirty-day expiry), so a key carrying a page would be a second
 * cache entry holding the same bytes. It said otherwise until STORY-006-04 shipped the screen: the
 * group was `entityQueryKeys<SessionListParams>('sessions')` with `page`/`perPage`, written before
 * any endpoint existed and describing a contract that never arrived.
 *
 * No `detail` either, and that is the contract rather than an omission: there is no
 * `GET /auth/sessions/{id}`. The two operations that address a session — revoke one, revoke the
 * rest — are writes, and both invalidate the group root, which is why `list()` starts with it.
 */
export interface SessionQueryKeys {
  readonly all: readonly [string];
  readonly list: () => readonly [string, 'list'];
}

/**
 * The registry. A group is added here by the epic that adds the operations behind it.
 *
 * Restated 2026-08-30. This said the registry held one group, «the client session
 * (`units/session`), the reference unit of the tree». There is no `units/session` — it was absorbed
 * into `units/auth` by EPIC-006, which `units/auth/index.ts` records — and the registry has grown
 * past one group several epics ago. What is in it is the object below; `ls packages/client/src/units`
 * lists the units that own those groups.
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
  /**
   * What **one other person** may do, with the layer that decided each key
   * (`GET /users/{userId}/permissions`, `permission-model.md` §7(ж)).
   *
   * A sibling of `mine()` under the same `all` prefix rather than a group of its own, and that is
   * the whole reason it is here: writing an exception changes the subject's `permissionsVersion`,
   * and the subject may be the caller — denying oneself `invoice:issue` is a supported shape
   * (`permission-override.policy.ts`, `governsRights` is deliberately narrow). One
   * `invalidateQueries({ queryKey: QueryKeys.Permissions.all })` therefore has to reach both this
   * address **and** `mine()`, which is what the guards and every `can(...)` in the shell read. Two
   * separate prefixes would leave the caller's own sidebar showing an action they had just taken
   * away from themselves, until a reload.
   */
  readonly ofUser: (userId: string) => readonly [string, 'user', string];
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

/**
 * Teams — a `list()` that takes no parameters, on purpose.
 *
 * `GET /teams` accepts none: it publishes every live team of the organization in one document, and
 * the screen's phrase, order and page are applied to that answer. Giving the key the filter would
 * keep one cache entry per phrase somebody typed, each of them a copy of the same bytes — and the
 * `detail` of a team would then be invalidated from a list address that depends on what was in the
 * search box at the time.
 *
 * `detail` is here because the roster genuinely is a second read (`GET /teams/{teamId}`), and both
 * start with the same prefix so that adding a member invalidates the roster and the counts on the
 * list together.
 */
export interface TeamQueryKeys {
  readonly all: readonly [string];
  readonly list: () => readonly [string, 'list'];
  readonly detail: (id: string) => readonly [string, 'detail', string];
}

/**
 * Projects — one card and its roster, under one prefix.
 *
 * `members` is a second address because it is a second read (`GET /projects/{projectId}/members`),
 * and it sits under the same `all` so that a write to the project — renaming it, putting somebody
 * on it — reaches the card and the roster with one invalidation. `list` is the list screen
 * (STORY-014-04, `GET /projects`), under the same root for the same reason: creating, renaming or
 * archiving a project has to reach every page of the list as well as the card.
 */
export interface ProjectListParams {
  readonly q: string | null;
  readonly status: readonly string[];
  /** `null`, not `undefined`: a key is hashed as JSON, and `undefined` vanishes from it. */
  readonly lead: string | null;
  readonly member: 'me' | null;
  readonly sort: string;
  readonly page: number;
  readonly perPage: number;
}

export interface ProjectQueryKeys {
  readonly all: readonly [string];
  readonly list: (params: ProjectListParams) => readonly [string, 'list', ProjectListParams];
  readonly detail: (id: string) => readonly [string, 'detail', string];
  readonly members: (id: string) => readonly [string, 'members', string];
}

/**
 * The recovery-code counter — one address, and there will never be a second.
 *
 * `GET /auth/2fa/recovery-codes` answers `{ total, remaining }` about the caller and takes no
 * parameters, so there is no list and no detail: a `detail(id)` here would suggest an operation
 * that reads somebody else's codes, and no such operation exists or could.
 *
 * **What is deliberately not here is the codes themselves and the drafted secret.** Both are
 * answers to mutations and neither may become a cache entry (CLAUDE.md, «Чувствительность
 * данных»); giving them a key would be the first step towards persisting them.
 */
export interface RecoveryCodeQueryKeys {
  readonly all: readonly [string];
  readonly status: () => readonly [string, 'status'];
}

/**
 * Open invitations — a `list()` with no parameters, because the operation has none.
 *
 * `GET /invitations` accepts no filter, no page and no order: it answers with every unaccepted
 * invitation of the organization, newest first, and the order is the server's. A key carrying
 * anything would therefore be a second cache entry holding the same bytes.
 *
 * No `detail` either, and that is the contract rather than an omission: there is no
 * `GET /invitations/{id}`. The two operations that address one invitation — re-issue and revoke —
 * are writes, and both invalidate the group root, which is why `list()` starts with it.
 */
export interface InvitationQueryKeys {
  readonly all: readonly [string];
  readonly list: () => readonly [string, 'list'];
}

/**
 * The organization's second-factor policy, and the report of who it affects.
 *
 * Two addresses under one prefix, because saving the policy changes both answers at once and one
 * `invalidateQueries({ queryKey: QueryKeys.SecurityPolicy.all })` has to reach them together — a
 * table still showing yesterday's verdicts beside a policy that has just changed is a screen that
 * disagrees with the door.
 *
 * `coverage` takes the **draft** it is reporting on, because the preview of a policy nobody has
 * saved is a different answer from the standing report and must not be served from its cache
 * entry: `undefined` addresses the stored policy, and every draft addresses its own.
 */
export interface CoverageDraftParams {
  readonly roles: readonly string[];
  readonly graceDays: number;
}

export interface SecurityPolicyQueryKeys {
  readonly all: readonly [string];
  readonly policy: () => readonly [string, 'policy'];
  readonly coverage: (
    draft: CoverageDraftParams | undefined,
  ) => readonly [string, 'coverage', CoverageDraftParams | null];
}

export const QueryKeys = {
  Sessions: {
    all: ['sessions'],
    list: () => ['sessions', 'list'],
  } satisfies SessionQueryKeys,
  RecoveryCodes: {
    all: ['recovery-codes'],
    status: () => ['recovery-codes', 'status'],
  } satisfies RecoveryCodeQueryKeys,
  Permissions: {
    all: ['permissions'],
    mine: () => ['permissions', 'mine'],
    ofUser: (userId: string) => ['permissions', 'user', userId],
  } satisfies PermissionQueryKeys,
  Roles: {
    all: ['roles'],
    matrix: () => ['roles', 'matrix'],
  } satisfies RoleQueryKeys,
  Employees: {
    ...entityQueryKeys<EmployeeListParams>('employees'),
    orgChart: () => ['employees', 'org-chart'],
  } satisfies EmployeeQueryKeys,
  Invitations: {
    all: ['invitations'],
    list: () => ['invitations', 'list'],
  } satisfies InvitationQueryKeys,
  Teams: {
    all: ['teams'],
    list: () => ['teams', 'list'],
    detail: (id: string) => ['teams', 'detail', id],
  } satisfies TeamQueryKeys,
  Projects: {
    all: ['projects'],
    list: (params: ProjectListParams) => ['projects', 'list', params],
    detail: (id: string) => ['projects', 'detail', id],
    members: (id: string) => ['projects', 'members', id],
  } satisfies ProjectQueryKeys,
  SecurityPolicy: {
    all: ['security-policy'],
    policy: () => ['security-policy', 'policy'],
    // `null` rather than `undefined` for «the stored policy»: a key is serialised for hashing, and
    // `undefined` in an array is not distinguishable from a missing element on the way back.
    // The roles are **sorted** into the key: «admin then manager» and «manager then admin» are one
    // question, and two entries for it would be two requests answered identically and a preview that
    // depends on the order somebody happened to tick boxes in.
    coverage: (draft) =>
      draft === undefined
        ? ['security-policy', 'coverage', null]
        : ['security-policy', 'coverage', { ...draft, roles: [...draft.roles].sort() }],
  } satisfies SecurityPolicyQueryKeys,
} as const;
