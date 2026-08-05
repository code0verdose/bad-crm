import { SharedPermissions } from '@bad-crm/shared';

import {
  type CapabilityFacts,
  type EffectivePermissionsReaderPort,
} from '@/application/iam/ports/effective-permissions-reader.port.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

/**
 * What one person may do, assembled from their roles.
 *
 * Three properties of this read are load-bearing:
 *
 * **Expiry is a predicate.** `expiresAt IS NULL OR expiresAt > now()` filters the assignments here,
 * not in a cleanup job: a temporary role has to stop granting at its expiry, not at the next run of
 * something nobody watches.
 *
 * **A deprecated permission grants nothing.** A key removed from the code stays in the catalogue so
 * existing grants survive (`docs/architecture/data-model.md`, group 2), and the policy layer must
 * resolve it to «no permission» — so it is filtered out here, at the only place that turns rows into
 * capabilities. A key the code no longer declares is dropped for the same reason: `PermissionKey` is
 * a closed type, and a string outside it cannot be checked at any call site.
 *
 * **Ownership comes from `organizations.owner_id`, not from holding a role called owner.** The one
 * property that has to survive a broken roles table is the one that says who can repair it.
 *
 * Per-user overrides (`denied`) are not read here: `UserPermissionOverride` arrives with
 * STORY-011-05. Until then the DENY half of the model is empty rather than assumed — the actor
 * carries an empty set, and `effectivePermission` treats it exactly as «no overrides exist».
 */
export class PrismaEffectivePermissionsReader
  extends TenantScopedRepository
  implements EffectivePermissionsReaderPort
{
  protected readonly resource = 'user' as const;
  protected readonly repositoryName = 'EffectivePermissionsReader';

  capabilitiesOf(userId: string): Promise<CapabilityFacts | null> {
    return this.run('capabilitiesOf', async (tx) => {
      const organizationId = this.organizationId('capabilitiesOf');

      const user = await tx.user.findFirst({
        where: { organizationId, id: userId, deletedAt: null },
        select: { id: true, permissionsVersion: true },
      });

      if (user === null) return null;

      const [organization, assignments] = await Promise.all([
        tx.organization.findFirst({ where: { id: organizationId }, select: { ownerId: true } }),
        tx.userRole.findMany({
          where: {
            organizationId,
            userId,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          select: {
            role: {
              select: {
                permissions: {
                  where: { permission: { deprecatedAt: null } },
                  select: { permissionKey: true },
                },
              },
            },
          },
        }),
      ]);

      const granted = new Set<SharedPermissions.PermissionKey>();

      for (const assignment of assignments) {
        for (const grant of assignment.role.permissions) {
          if (SharedPermissions.isPermissionKey(grant.permissionKey)) granted.add(grant.permissionKey);
        }
      }

      return {
        isOwner: organization?.ownerId === userId,
        granted: [...granted],
        permissionsVersion: user.permissionsVersion,
      };
    });
  }
}
