import { type SharedPermissions } from '@bad-crm/shared';

import {
  type OverrideDraftRow,
  type OverrideRow,
  type PermissionOverrideRepositoryPort,
} from '@/application/iam/ports/permission-override-repository.port.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

/**
 * Exceptions through Prisma, inside the scope the caller opened.
 *
 * The read here **keeps expired rows**, unlike the one that assembles permissions. The two answer
 * different questions: «what may this person do» must ignore an expired exception the moment it
 * expires, while «what exceptions exist for this person» is a screen an administrator reads, and an
 * exception that silently disappeared from it is one they cannot explain or remove.
 */
export class PrismaPermissionOverrideRepository
  extends TenantScopedRepository
  implements PermissionOverrideRepositoryPort
{
  protected readonly resource = 'user' as const;
  protected readonly repositoryName = 'PermissionOverrideRepository';

  listFor(userId: string): Promise<readonly OverrideRow[]> {
    return this.run('listFor', async (tx) => {
      const rows = await tx.userPermissionOverride.findMany({
        where: { organizationId: this.organizationId('listFor'), userId },
        orderBy: { permissionKey: 'asc' },
        select: { permissionKey: true, effect: true, reason: true, expiresAt: true },
      });

      return rows.map((row) => toOverrideRow(row));
    });
  }

  find(userId: string, permissionKey: string): Promise<OverrideRow | null> {
    return this.run('find', async (tx) => {
      const row = await tx.userPermissionOverride.findFirst({
        where: { organizationId: this.organizationId('find'), userId, permissionKey },
        select: { permissionKey: true, effect: true, reason: true, expiresAt: true },
      });

      return row === null ? null : toOverrideRow(row);
    });
  }

  upsert(draft: OverrideDraftRow): Promise<void> {
    return this.run('upsert', async (tx) => {
      const organizationId = this.organizationId('upsert');

      await tx.userPermissionOverride.upsert({
        where: {
          userId_permissionKey: { userId: draft.userId, permissionKey: draft.permissionKey },
        },
        create: {
          organizationId,
          userId: draft.userId,
          permissionKey: draft.permissionKey,
          effect: draft.effect,
          reason: draft.reason,
          expiresAt: draft.expiresAt,
          grantedById: draft.grantedById,
        },
        // The grantor and the moment are rewritten too: a changed exception is a new decision by a
        // new person, and a trail that kept the first author would name the wrong one.
        update: {
          effect: draft.effect,
          reason: draft.reason,
          expiresAt: draft.expiresAt,
          grantedById: draft.grantedById,
          grantedAt: new Date(),
        },
      });
    });
  }

  remove(userId: string, permissionKey: string): Promise<boolean> {
    return this.run('remove', async (tx) => {
      const { count } = await tx.userPermissionOverride.deleteMany({
        where: { organizationId: this.organizationId('remove'), userId, permissionKey },
      });

      return count > 0;
    });
  }
}

const toOverrideRow = (row: {
  permissionKey: string;
  effect: 'ALLOW' | 'DENY';
  reason: string;
  expiresAt: Date | null;
}): OverrideRow => ({
  permissionKey: row.permissionKey as SharedPermissions.PermissionKey,
  effect: row.effect,
  reason: row.reason,
  expiresAt: row.expiresAt,
});
