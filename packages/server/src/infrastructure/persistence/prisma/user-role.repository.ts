import { type SharedPermissions } from '@bad-crm/shared';

import {
  type AssignmentDraft,
  type AssignmentResult,
  type RoleFacts,
  type UserRoleRepositoryPort,
} from '@/application/iam/ports/user-role-repository.port.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

/**
 * Assignments through Prisma, inside the scope the caller opened.
 *
 * Two details are the whole of the class:
 *
 * **Expiry is a predicate, not a job.** Every read of what somebody holds filters
 * `expiresAt IS NULL OR expiresAt > now()`. The cleanup job removes the rows eventually; until it
 * runs, an expired role must already grant nothing — otherwise «temporary access» means «access
 * until a job we do not monitor happens to run».
 *
 * **Assignment is idempotent by constraint.** `uq_user_roles` makes the pair unique, so the second
 * assignment is a no-op rather than a duplicate — and reporting *which* it was matters: the caller
 * bumps a version and writes a trail entry only when something actually changed.
 */
export class PrismaUserRoleRepository
  extends TenantScopedRepository
  implements UserRoleRepositoryPort
{
  protected readonly resource = 'role' as const;
  protected readonly repositoryName = 'UserRoleRepository';

  roleFacts(roleId: string): Promise<RoleFacts | null> {
    return this.run('roleFacts', async (tx) => {
      const role = await tx.role.findFirst({
        where: { organizationId: this.organizationId('roleFacts'), id: roleId },
        select: { id: true, key: true, permissions: { select: { permissionKey: true } } },
      });

      if (role === null) return null;

      return {
        roleId: role.id,
        key: role.key,
        permissions: role.permissions.map(
          (grant) => grant.permissionKey as SharedPermissions.PermissionKey,
        ),
      };
    });
  }

  roleIdsOf(userId: string): Promise<readonly string[]> {
    return this.run('roleIdsOf', async (tx) => {
      const rows = await tx.userRole.findMany({
        where: {
          organizationId: this.organizationId('roleIdsOf'),
          userId,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { roleId: true },
      });

      return rows.map((row) => row.roleId);
    });
  }

  userExists(userId: string): Promise<boolean> {
    return this.run('userExists', async (tx) => {
      const user = await tx.user.findFirst({
        where: {
          organizationId: this.organizationId('userExists'),
          id: userId,
          deletedAt: null,
        },
        select: { id: true },
      });

      return user !== null;
    });
  }

  countHoldersOfKey(key: string, excludingUserId?: string): Promise<number> {
    return this.run('countHoldersOfKey', async (tx) =>
      tx.userRole.count({
        where: {
          organizationId: this.organizationId('countHoldersOfKey'),
          role: { key },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          ...(excludingUserId === undefined ? {} : { userId: { not: excludingUserId } }),
        },
      }),
    );
  }

  assign(draft: AssignmentDraft): Promise<AssignmentResult> {
    return this.run('assign', async (tx) => {
      const organizationId = this.organizationId('assign');
      const existing = await tx.userRole.findFirst({
        where: { organizationId, userId: draft.userId, roleId: draft.roleId },
        select: { id: true },
      });

      if (existing !== null) return { created: false };

      await tx.userRole.create({
        data: {
          organizationId,
          userId: draft.userId,
          roleId: draft.roleId,
          grantedById: draft.grantedById,
          expiresAt: draft.expiresAt,
        },
      });

      return { created: true };
    });
  }

  revoke(userId: string, roleId: string): Promise<boolean> {
    return this.run('revoke', async (tx) => {
      const { count } = await tx.userRole.deleteMany({
        where: { organizationId: this.organizationId('revoke'), userId, roleId },
      });

      return count > 0;
    });
  }

  bumpPermissionsVersion(userId: string): Promise<void> {
    return this.run('bumpPermissionsVersion', async (tx) => {
      await tx.user.updateMany({
        where: { organizationId: this.organizationId('bumpPermissionsVersion'), id: userId },
        data: { permissionsVersion: { increment: 1 } },
      });
    });
  }
}
