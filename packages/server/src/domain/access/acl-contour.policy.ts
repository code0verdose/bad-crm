import { type SharedPermissions } from '@bad-crm/shared';

import { type Decision } from '@/domain/access/decision.types.js';
import { deny } from '@/domain/access/decision.util.js';

/**
 * The kinds of object whose `NONE` means «not there», not «forbidden».
 *
 * One member today, and deliberately not decided for the rest: the project closed its contour in
 * its own domain (`closeTheContour` in `domain/project/access/project-access.policy.ts`, STORY-014-03
 * acceptance 6 — a `PRIVATE` project is `NONE` for everybody not on it, and only a 404 does not
 * confirm it exists). Whether `NONE` on any other kind is a 404 is STORY-011-06 acceptance 3, an
 * open decision about `access.errors.ts` that is not this list's to take; a kind joins here with
 * its domain's decision, not before.
 */
const CLOSED_CONTOURS: ReadonlySet<SharedPermissions.AclResourceType> = new Set(['PROJECT']);

/**
 * The same remap the project's own reads apply, for the grant routes that read the same chain.
 *
 * Without it `/acl` would be the oracle the project card is not: the card answers a `PRIVATE`
 * project one is not on as `project_not_found`, and `GET /acl?resourceType=PROJECT&resourceId=…`
 * would answer the very same id `project_forbidden`. The key travels with the remapped refusal, as
 * it does in the project's remap — the denial trail files a refusal on a `dangerous` key by it, and
 * `acl:grant` and `acl:revoke` are two.
 */
export const closeContourOf = (
  type: SharedPermissions.AclResourceType,
  decision: Decision,
): Decision =>
  !decision.allowed && decision.reason === 'acl_explicit_none' && CLOSED_CONTOURS.has(type)
    ? deny('resource_not_found', decision.permissionKey)
    : decision;
