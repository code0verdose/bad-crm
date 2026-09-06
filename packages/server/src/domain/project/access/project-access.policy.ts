import { type SharedPermissions } from '@bad-crm/shared';

import { type Actor } from '@/domain/access/actor.types.js';
import { type AclScope, authorizeWith } from '@/domain/access/authorize.util.js';
import { type Decision } from '@/domain/access/decision.types.js';
import { allow, assertAllowed, deny } from '@/domain/access/decision.util.js';
import { type ProjectScope } from '@/domain/project/project.entity.js';

/** The keys of the project domain — the only ones this policy may be asked about. */
export type ProjectPermissionKey = Extract<SharedPermissions.PermissionKey, `project:${string}`>;

/**
 * What two readers answered about one project for one caller — and nothing else.
 *
 * `scope` is the repository's read by id, flagged rather than filtered: a deleted row arrives as
 * `isDeleted: true` so that «what a deleted project answers» is decided here and not by a `WHERE`
 * clause. `acl` is the resolver's answer with the implicit table and the explicit grants already
 * folded into one level (`resolve-acl.query.ts`): a `LEAD` is `MANAGER`, a bystander of a
 * `PUBLIC_ORG` project is `VIEWER`, a bystander of a `PRIVATE` one is `NONE`, an expired grant is
 * no grant. The policy does not walk that table again — it is one table, in one place, with one
 * test (`implicit-level.policy.ts`).
 */
export interface ProjectAccessFacts {
  readonly scope: ProjectScope | null;
  readonly acl: AclScope;
}

/**
 * Whether this id names a project the caller may go on to address.
 *
 * `null` and «soft-deleted» are one answer. The row survives a deletion — `projects.deleted_at` is
 * set rather than the row removed, so the key can be reused — which means a repository can still
 * see something the caller must not be told about. Anything but `resource_not_found` here would
 * let the API confirm that an id once named a project in this organization.
 */
export const projectAddressable = (scope: ProjectScope | null): Decision =>
  scope === null || scope.isDeleted ? deny('resource_not_found') : allow();

/**
 * The same decision, in the form a caller that goes on to *use* the row needs — the shape
 * `assertTeamAddressable` has, for the same reason: after this call the row is non-null for the
 * compiler, so the code that reads `project.name` right after deciding it exists is also the code
 * that type-checks.
 */
export function assertProjectAddressable<T extends ProjectScope>(
  scope: T | null,
): asserts scope is T {
  assertAllowed(projectAddressable(scope), 'project');
}

/**
 * What the ladder is handed: the resolver's scope, unless the row itself says there is nothing to
 * hold a level on.
 *
 * `missing` for a row that is deleted or not there, whatever the chain said — a grant on a deleted
 * project is a grant on nothing, and the resolver's own reader would not have found the row either.
 * Written as a separate function so the table test can hold it still without going through the
 * capability rungs.
 */
export const projectAclScope = (facts: ProjectAccessFacts): AclScope =>
  projectAddressable(facts.scope).allowed ? facts.acl : { status: 'missing' };

/**
 * A project is a **closed contour**: `NONE` on its chain is «not there», never «forbidden».
 *
 * `authorizeResource` answers an explicit `NONE` as `acl_explicit_none`, a 403 — the right answer
 * for a resource whose existence is not a secret. A project's is: `visibility = PRIVATE` means the
 * people who are not on it must not learn it exists, and the implicit table encodes exactly that
 * as `NONE` (§5, «`PRIVATE` · не участник → `NONE` (→ 404)»). The same holds for an explicit `NONE`
 * a lead put on one person — the model reads it as «for you, this project is not there»
 * (STORY-014-03, acceptance 6: «любой отказ по причине … `NONE` на цепочке → 404»). The owner never
 * reaches this branch: `authorizeResource` clears the level for them first, so rule 9 of
 * `rules/permissions.mdc` («DENY-override не действует на owner») is not undone here.
 *
 * The key travels with the remapped refusal, as it does with every other one — the denial trail
 * files a refusal on a `dangerous` key by that field, and `project:delete` is one.
 */
const closeTheContour = (decision: Decision, key: ProjectPermissionKey): Decision =>
  !decision.allowed && decision.reason === 'acl_explicit_none'
    ? deny('resource_not_found', key)
    : decision;

/**
 * The whole decision about one project for one key: capability first, the readers only after.
 *
 * `authorizeWith` is the ladder — the rungs of the model in the order the model states them,
 * written once in `packages/shared` and translated to a `DenyReason` in `authorize.util.ts` — and
 * this function adds the two things only the project knows: that a deleted row is nobody's
 * (`projectAclScope`) and that the contour is closed (`closeTheContour`). No rung is walked here.
 *
 * `facts` is a function rather than a value, and that is the resource half of STORY-011-07's
 * acceptance 3: it is invoked only once the capability holds, so a caller without the key is
 * refused before a statement about the project is sent, and «you have no permission» costs no
 * read of the row at all.
 *
 * Pure in the sense the layer requires: no I/O of its own, no clock, nothing imported from
 * outside the domain — the reads belong to the ports the use-case passes in.
 */
export const decideProjectAccess = async (
  actor: Actor | null,
  key: ProjectPermissionKey,
  facts: () => Promise<ProjectAccessFacts>,
): Promise<Decision> =>
  closeTheContour(await authorizeWith(actor, key, async () => projectAclScope(await facts())), key);

/** May this caller read this project — `project:read`, `VIEWER` on the chain. */
export const canReadProject = (
  actor: Actor | null,
  facts: () => Promise<ProjectAccessFacts>,
): Promise<Decision> => decideProjectAccess(actor, 'project:read', facts);
