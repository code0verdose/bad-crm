import { type AclReaderPort } from '@/application/access/ports/acl-reader.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type ProjectListViewer } from '@/application/project/ports/project-list-query.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { accessErrorFor } from '@/domain/access/access.errors.js';
import { visibleProjectsPlan } from '@/domain/project/access/visible-projects.policy.js';

export interface ProjectListViewerSources {
  readonly acl: AclReaderPort;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
}

/**
 * Whose list this is and which rows they may see — the one way every project list reads it.
 *
 * The organization node of the chain is read once, and `visibleProjectsPlan` turns it into the plan
 * each row is judged by (`visible-projects.policy.ts`). Both the list (`ListProjectsQuery`) and the
 * switcher (`ListProjectOptionsQuery`) take their viewer from here, so «which projects can this
 * person see» has one answer on every surface — STORY-014-03 acceptance 4 asks for a single
 * visibility function, and two copies of this read would be a second one waiting to drift.
 *
 * The capability is **not** decided here: each query asserts `canListProjects` itself, first, so the
 * authority stays visible in the class the route names in `aclCheckedIn`.
 *
 * **A failed read of the organization node is a 503**, `acl_resolution_failed` — the answer the
 * resolver gives on the detail read for the same failure. An empty list would say «you have no
 * projects», a list without the grants would say more than it may; neither is «we could not check».
 */
export const readProjectListViewer = async (
  actor: Actor,
  { acl, clock, logger }: ProjectListViewerSources,
): Promise<ProjectListViewer> => {
  let grants;

  try {
    grants = await acl.entriesAlong(
      [{ depth: 0, type: 'ORGANIZATION', id: actor.organizationId }],
      actor.userId,
    );
  } catch (error) {
    // Logged here, as `resolve-acl.query.ts` logs the same failure on the detail read: the refusal
    // below carries a reason and no cause, and the cause is what an operator needs.
    logger.warn({ resourceType: 'ORGANIZATION', err: error }, 'acl resolution failed');

    throw accessErrorFor('acl_resolution_failed', 'project', undefined, 'project:read');
  }

  return { userId: actor.userId, plan: visibleProjectsPlan(actor, grants, clock.now()) };
};
