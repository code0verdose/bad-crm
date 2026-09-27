import { SharedPermissions } from '@bad-crm/shared';

import { type AclEntryOnChain } from '@/domain/access/acl-chain.types.js';
import { resolveFromChain } from '@/domain/access/acl-resolution.policy.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { implicitLevel } from '@/domain/access/implicit-level.policy.js';
import { canReadProject } from '@/domain/project/access/project-access.policy.js';
import { type ProjectRole, type ProjectVisibility } from '@/domain/project/project.enums.js';

/**
 * One colleague of the organization, as the read decision needs them for one project: their folded
 * capability view, their live seat on the project (or `null`), and every live grant that reaches
 * them on the chain `PROJECT (depth 0) → ORGANIZATION (depth 1)` — through themselves, a role or a
 * team, exactly what `AclReaderPort.entriesAlong` answers for one person.
 */
export interface ProjectAudienceSeat {
  readonly actor: Actor;
  readonly memberRole: ProjectRole | null;
  readonly entries: readonly AclEntryOnChain[];
}

/** The project as the question is asked about it — the row that exists, under one visibility. */
export interface ProjectUnderVisibility {
  readonly projectId: string;
  readonly organizationId: string;
  readonly visibility: ProjectVisibility;
}

/** How many colleagues a change takes the project away from, and how many it hands it to. */
export interface VisibilityImpact {
  readonly losingAccess: number;
  readonly gainingAccess: number;
}

/**
 * Would this colleague read the project if it had this visibility — `canReadProject`, the decision
 * `GetProjectDetailQuery` asserts, fed the facts it would be fed.
 *
 * Nothing about access is restated here. The level is the resolver's composition — the implicit
 * table under the hypothetical visibility (`implicitLevel`), the chain rule over the colleague's
 * grants (`resolveFromChain`) — and the verdict is the project policy's, owner rule, closed contour
 * and capability ladder included. What changes between the two calls is one fact, the visibility,
 * which is the only fact the implicit table reads about the project; explicit grants and seats are
 * the same on both sides, so «a grant keeps access» and «a member keeps access» are not rules of
 * this function but consequences of the one it calls.
 */
export const readsProjectUnder = async (
  seat: ProjectAudienceSeat,
  project: ProjectUnderVisibility,
  now: Date,
): Promise<boolean> => {
  const level = resolveFromChain(
    seat.entries,
    implicitLevel(seat.actor, {
      resourceType: 'PROJECT',
      visibility: project.visibility,
      memberRole: seat.memberRole,
    }),
    now,
  );

  const decision = await canReadProject(seat.actor, () =>
    Promise.resolve({
      scope: { projectId: project.projectId, isDeleted: false, visibility: project.visibility },
      acl: {
        status: 'resolved',
        organizationId: project.organizationId,
        level,
        family: SharedPermissions.ACL_RESOURCE_FAMILY.PROJECT,
      },
    }),
  );

  return decision.allowed;
};

/**
 * The summary the confirmation of a visibility change shows (STORY-014-01, acceptance 7): the set
 * difference of «reads it now» and «reads it afterwards», over every colleague handed in.
 *
 * Who is handed in is the reader's question (active accounts of the organization); who of them
 * reads the project is this one's, seat by seat, through `readsProjectUnder`.
 */
export const visibilityImpact = async (
  seats: readonly ProjectAudienceSeat[],
  project: ProjectUnderVisibility,
  to: ProjectVisibility,
  now: Date,
): Promise<VisibilityImpact> => {
  let losingAccess = 0;
  let gainingAccess = 0;

  for (const seat of seats) {
    const before = await readsProjectUnder(seat, project, now);
    const after = await readsProjectUnder(seat, { ...project, visibility: to }, now);

    if (before && !after) losingAccess += 1;
    if (!before && after) gainingAccess += 1;
  }

  return { losingAccess, gainingAccess };
};
