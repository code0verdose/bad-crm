import { SharedPermissions } from '@bad-crm/shared';
import { isoDateTimeSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

import { RESOLVABLE_ACL_RESOURCE_TYPES } from '@/application/access/resolvable-acl-resource-types.constant.js';

/**
 * The request schemas of the grant surface — `GET`/`POST /acl`, `DELETE /acl/{aclId}`.
 *
 * **`resourceType` is the resolvable subset, not the table's twelve kinds.** A grant on a `BOARD`
 * is a row the table would accept and no resolver can walk: the resolver answers `unavailable`, the
 * route would answer `503`, and a client would retry something that can never succeed. `422` at the
 * edge is the honest answer, and the list is the one the resolver's registry is keyed by
 * (`resolvable-acl-resource-types.constant.ts`), so the two cannot drift.
 *
 * Every id is a uuid for the reason `project.validator.ts` gives: the adapters bind them as
 * `::uuid`, and a value that is not one would be a `500` from PostgreSQL rather than a `422` here.
 * Refusing a malformed id says nothing about existence.
 */

/**
 * A plain uuid, not a branded one: `resourceId` names a project or the organization depending on
 * `resourceType`, and `subjectId` a user, a role or a team — no single brand is true of either.
 * The message key is the one every branded id uses.
 */
const uuidSchema = z.uuid({ error: 'validation.id.invalid' });

const resourceTypeSchema = z.enum(RESOLVABLE_ACL_RESOURCE_TYPES, {
  error: 'validation.aclResourceType.invalid',
});

const subjectTypeSchema = z.enum(SharedPermissions.ACL_SUBJECT_TYPES, {
  error: 'validation.aclSubjectType.invalid',
});

const accessLevelSchema = z.enum(SharedPermissions.ACCESS_LEVELS, {
  error: 'validation.accessLevel.invalid',
});

/** ISO 8601 in UTC on the wire, a `Date` for the use-case; absent or `null` is «until revoked». */
const expiresAtSchema = isoDateTimeSchema
  .transform((value) => new Date(value))
  .nullish()
  .transform((value) => value ?? null);

/** `?resourceType=PROJECT&resourceId=…` — the object whose grants are listed. */
export const aclListQuerySchema = z.strictObject({
  resourceType: resourceTypeSchema,
  resourceId: uuidSchema,
});

/**
 * One grant: who, on what, how much, until when.
 *
 * `NONE` is a level like the others — the explicit refusal on a node and below — and is accepted
 * here; the one `NONE` the model refuses (on one's own `USER` entry) is the policy's
 * `self_lockout`, decided with the actor in hand. A past `expiresAt` is not refused either: it is a
 * grant that decides nothing from the moment it is written, which the resolver and the list both
 * read as absent.
 */
export const grantAclBodySchema = z.strictObject({
  resourceType: resourceTypeSchema,
  resourceId: uuidSchema,
  subjectType: subjectTypeSchema,
  subjectId: uuidSchema,
  accessLevel: accessLevelSchema,
  expiresAt: expiresAtSchema,
});

export const aclIdParamsSchema = z.strictObject({ aclId: uuidSchema });
