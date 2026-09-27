import { type SharedPermissions } from '@bad-crm/shared';

import { type CapabilityFacts } from '@/application/iam/ports/effective-permissions-reader.port.js';
import { type Actor } from '@/domain/access/actor.types.js';

/**
 * One person's capability facts, as the actor every policy takes.
 *
 * The one place this shape is assembled: `BuildActorQuery` builds the caller with it, and a read
 * that decides about other people (the audience of a visibility change) builds each of them with
 * it — so a colleague is judged as exactly the actor they would be on their own request.
 */
export const actorFromFacts = (
  userId: string,
  organizationId: string,
  facts: CapabilityFacts,
): Actor => ({
  userId,
  organizationId,
  isOwner: facts.isOwner,
  permissionsVersion: facts.permissionsVersion,
  permissions: new Set<SharedPermissions.PermissionKey>(facts.granted),
  denied: new Set<SharedPermissions.PermissionKey>(facts.denied),
  roleKeys: facts.roleKeys,
});
