import { type SharedPermissions } from '@bad-crm/shared';

import { type AclListEntry } from '@/application/access/ports/acl-repository.port.js';

/**
 * One grant → the `ResourceAclEntry` schema of `docs/api/openapi.yaml`.
 *
 * A whitelist, field by field, rather than a spread of the read model — the rule every serializer
 * here keeps: the read model is free to grow a field for a policy or a trail, and a spread would put
 * it on the wire the day it did. Ids only, no names: who a user, a role or a team is belongs to the
 * directory and the roles screen, each behind its own permission.
 */
export interface ResourceAclEntryResponse {
  readonly id: string;
  readonly resourceType: SharedPermissions.AclResourceType;
  readonly resourceId: string;
  readonly subjectType: SharedPermissions.AclSubjectType;
  readonly subjectId: string;
  readonly accessLevel: SharedPermissions.AccessLevel;
  readonly expiresAt: string | null;
  readonly grantedById: string | null;
  readonly grantedAt: string;
}

export const serializeResourceAclEntry = (entry: AclListEntry): ResourceAclEntryResponse => ({
  id: entry.id,
  resourceType: entry.resource.type,
  resourceId: entry.resource.id,
  subjectType: entry.subject.type,
  subjectId: entry.subject.id,
  accessLevel: entry.level,
  expiresAt: entry.expiresAt === null ? null : entry.expiresAt.toISOString(),
  grantedById: entry.grantedById,
  grantedAt: entry.grantedAt.toISOString(),
});
