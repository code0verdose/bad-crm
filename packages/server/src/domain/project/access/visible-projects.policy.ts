import { SharedPermissions } from '@bad-crm/shared';

import { type AclEntryOnChain } from '@/domain/access/acl-chain.types.js';
import { resolveFromChain } from '@/domain/access/acl-resolution.policy.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { authorizeCapability, authorizeResource } from '@/domain/access/authorize.util.js';
import { type Decision } from '@/domain/access/decision.types.js';
import { implicitLevel } from '@/domain/access/implicit-level.policy.js';
import {
  PROJECT_ROLES,
  PROJECT_VISIBILITIES,
  type ProjectRole,
  type ProjectVisibility,
} from '@/domain/project/project.enums.js';

/** The key a list of projects is read under — the same one the card is (`project:read`, `VIEWER`). */
const LIST_KEY = 'project:read' satisfies SharedPermissions.PermissionKey;

/** One cell of the implicit table for a project: how it is shared, and the caller's seat on it. */
export interface ImplicitProjectCase {
  readonly visibility: ProjectVisibility;
  /** The caller's live membership (`left_at IS NULL`), or `null` when they are not on the project. */
  readonly memberRole: ProjectRole | null;
}

/**
 * Which projects one caller may see — decided **once per request**, then applied to every row.
 *
 * The chain of a project is two nodes, `PROJECT → ORGANIZATION` (`resolve-acl.query.ts`), and of
 * the two only the project node differs from row to row. So the organization node is read once,
 * the rule is applied to it here, and what is left for a row is a lookup in two short lists:
 *
 * - `readableExplicitLevels` — a project that carries a live explicit grant for the caller is
 *   decided by that grant alone (the closest node wins, `acl-resolution.policy.ts` rule 1), and
 *   the grants fold to one level; the row is visible when that level is in this list;
 * - `implicitlyVisible` — a project without one falls through to the organization node, and when
 *   that is silent too, to the implicit table; the row is visible when its `(visibility,
 *   memberRole)` is in this list.
 *
 * **Both lists are computed by asking the per-row decision, not by restating it.** Every cell is the
 * answer `implicitLevel` → `resolveFromChain` → `authorizeResource` gives — the three functions
 * `GetProjectDetailQuery` decides one project with — over the finite set of inputs a row can have:
 * five levels, two visibilities, four roles and «not on it». That is what makes this the single
 * visibility function STORY-014-03 acceptance 4 asks for rather than a second copy of the model: the
 * owner reading everything, a guest reading nothing without a grant, `NONE` on the organization
 * closing what has no grant of its own — none of it is written here, all of it arrives through the
 * cells. `visible-projects-policy.test.ts` compares the result with the per-row decision over every
 * combination and names the row that disagrees.
 *
 * The capability is not part of the plan: `canListProjects` decides it first, before the organization
 * node is read, so a caller without `project:read` costs no statement about access at all.
 */
export interface ProjectVisibilityPlan {
  readonly readableExplicitLevels: readonly SharedPermissions.AccessLevel[];
  readonly implicitlyVisible: readonly ImplicitProjectCase[];
}

/** What a row carries into the decision — nothing that is not a fact about access. */
export interface ProjectVisibilityRow extends ImplicitProjectCase {
  /** What the caller's live grants on the project node fold to, or `null` when there are none. */
  readonly explicitLevel: SharedPermissions.AccessLevel | null;
}

/** `project:read` as a capability — the first rung, before any row is looked at. */
export const canListProjects = (actor: Actor | null): Decision =>
  authorizeCapability(actor, LIST_KEY);

/**
 * The caller's live grants on one node, folded — or `null` when none is live.
 *
 * `null` and `NONE` are different answers and the difference is the whole point: `NONE` is an
 * explicit «not for you» that stops the walk at this node, `null` lets it continue to the next one.
 * The folding itself is `resolveFromChain`'s (NONE beats all, else the maximum, expired entries
 * absent); only the «is anything live» question is asked here.
 */
export const explicitLevelOn = (
  entries: readonly AclEntryOnChain[],
  now: Date,
): SharedPermissions.AccessLevel | null => {
  const live = entries.filter(
    (entry) => entry.expiresAt === null || entry.expiresAt.getTime() > now.getTime(),
  );

  return live.length === 0 ? null : resolveFromChain(live, 'NONE', now);
};

/**
 * The plan for one caller, from the grants on their organization node.
 *
 * `organizationEntries` is what `AclReaderPort.entriesAlong` answers for the one-node chain
 * `[ORGANIZATION]`; the depth they carry is irrelevant here, because they all sit on one node.
 */
export const visibleProjectsPlan = (
  actor: Actor,
  organizationEntries: readonly AclEntryOnChain[],
  now: Date,
): ProjectVisibilityPlan => {
  const readable = (level: SharedPermissions.AccessLevel): boolean =>
    authorizeResource(actor, LIST_KEY, {
      status: 'resolved',
      organizationId: actor.organizationId,
      level,
      family: SharedPermissions.ACL_RESOURCE_FAMILY.PROJECT,
    }).allowed;

  const cases = PROJECT_VISIBILITIES.flatMap((visibility) =>
    [...PROJECT_ROLES, null].map((memberRole): ImplicitProjectCase => ({ visibility, memberRole })),
  );

  return {
    readableExplicitLevels: SharedPermissions.ACCESS_LEVELS.filter(readable),
    implicitlyVisible: cases.filter((cell) =>
      readable(
        resolveFromChain(
          organizationEntries,
          implicitLevel(actor, { resourceType: 'PROJECT', ...cell }),
          now,
        ),
      ),
    ),
  };
};

/**
 * One row under a plan — the predicate the list's SQL restates, and the one a double applies.
 *
 * Kept beside the plan so that «what the SQL means» has a definition the test can hold the plan
 * against; the adapter is held against it by the integration suite, row by row, on a live database.
 */
export const isProjectVisible = (
  plan: ProjectVisibilityPlan,
  row: ProjectVisibilityRow,
): boolean =>
  row.explicitLevel === null
    ? plan.implicitlyVisible.some(
        (cell) => cell.visibility === row.visibility && cell.memberRole === row.memberRole,
      )
    : plan.readableExplicitLevels.includes(row.explicitLevel);
