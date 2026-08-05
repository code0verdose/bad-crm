import {
  type RoleRepositoryPort,
  type RoleSummary,
  type SystemRoleDraft,
} from '@/application/iam/ports/role-repository.port.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';
import { type TxClient } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * Roles and their grants, through Prisma, inside the scope the caller opened.
 *
 * The whole class is one operation and one read, and the operation is idempotent by construction: it
 * runs when an organization is created **and** on every upgrade, because the composition of a system
 * role is code. Anything that is not idempotent here becomes a duplicate role on the second release.
 */
export class PrismaRoleRepository extends TenantScopedRepository implements RoleRepositoryPort {
  protected readonly resource = 'role' as const;
  protected readonly repositoryName = 'RoleRepository';

  /**
   * Writes the system roles and replaces their grants with what the code says.
   *
   * **Replace, not merge.** A permission removed from a system role in a release has to disappear
   * from every installation, and merging would leave it granted for ever — the release notes would
   * say «the administrator no longer sees costs» while the administrator still did. The replacement
   * is scoped to system roles: a custom role belongs to the organization, not to the release, and an
   * upgrade that rewrote one would silently change who can do what.
   *
   * **`isDefault` is exclusive.** A partial unique index enforces one default per organization, so
   * the flag is cleared before it is set — otherwise re-running this after the default changed would
   * hit the index rather than move the flag.
   */
  provisionSystemRoles(drafts: readonly SystemRoleDraft[]): Promise<readonly RoleSummary[]> {
    return this.run('provisionSystemRoles', async (tx) => {
      const organizationId = this.organizationId('provisionSystemRoles');

      for (const draft of drafts) {
        const role = await tx.role.upsert({
          where: { organizationId_key: { organizationId, key: draft.key } },
          create: {
            organizationId,
            key: draft.key,
            name: draft.name,
            isSystem: true,
            isDefault: false,
            priority: draft.priority,
          },
          update: { name: draft.name, isSystem: true, priority: draft.priority },
          select: { id: true },
        });

        await tx.rolePermission.deleteMany({ where: { organizationId, roleId: role.id } });
        await tx.rolePermission.createMany({
          data: draft.permissions.map((permissionKey) => ({
            organizationId,
            roleId: role.id,
            permissionKey,
          })),
        });
      }

      const defaultKey = drafts.find((draft) => draft.isDefault)?.key;

      if (defaultKey !== undefined) {
        await tx.role.updateMany({
          where: { organizationId, isDefault: true, key: { not: defaultKey } },
          data: { isDefault: false },
        });
        await tx.role.updateMany({
          where: { organizationId, key: defaultKey },
          data: { isDefault: true },
        });
      }

      return this.summaries(tx);
    });
  }

  listRoles(): Promise<readonly RoleSummary[]> {
    return this.run('listRoles', async (tx) => this.summaries(tx));
  }

  /**
   * Reads the scope rather than taking it, and the linter is right to insist: a repository that
   * accepted an `organizationId` would carry a second answer to «which tenant», and when the two
   * disagree the query is not refused — it is silently filtered to nothing.
   */
  private async summaries(tx: TxClient): Promise<readonly RoleSummary[]> {
    const rows = await tx.role.findMany({
      where: { organizationId: this.organizationId('summaries') },
      orderBy: { priority: 'desc' },
      select: {
        id: true,
        key: true,
        isSystem: true,
        isDefault: true,
        _count: { select: { permissions: true } },
      },
    });

    return rows.map((row: (typeof rows)[number]) => ({
      id: row.id,
      key: row.key,
      isSystem: row.isSystem,
      isDefault: row.isDefault,
      permissionCount: row._count.permissions,
    }));
  }
}
