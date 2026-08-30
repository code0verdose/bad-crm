import {
  type RoleRepositoryPort,
  type RoleSummary,
  type SystemRoleChange,
  type SystemRoleDraft,
  type SystemRoleProvisioning,
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
  provisionSystemRoles(drafts: readonly SystemRoleDraft[]): Promise<SystemRoleProvisioning> {
    return this.run('provisionSystemRoles', async (tx) => {
      const organizationId = this.organizationId('provisionSystemRoles');

      // Read before writing, because the write below is a replacement and afterwards there is
      // nothing left to compare against. This is what makes «only record what actually moved»
      // possible at all: an upgrade re-provisions every organization of the installation, and a
      // trail that could not tell an idempotent run from a real change would fill up with neither.
      const stored: ReadonlyMap<string, ReadonlySet<string>> = drafts.length === 0
        ? new Map()
        : await this.storedCompositions(tx, drafts);
      const changes: SystemRoleChange[] = [];

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

        const before = stored.get(draft.key);
        const change = describeChange(role.id, draft, before);

        if (change !== null) changes.push(change);

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

      return { roles: await this.summaries(tx), preexistingCount: stored.size, changes };
    });
  }

  /**
   * What the drafted roles grant right now, keyed by role key.
   *
   * Restricted to the keys being drafted rather than to `isSystem`, because that is what the upsert
   * below targets: a row is «pre-existing» here exactly when the upsert will update rather than
   * insert it, and any other definition would report a change that did not happen.
   */
  private async storedCompositions(
    tx: TxClient,
    drafts: readonly SystemRoleDraft[],
  ): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    const rows = await tx.role.findMany({
      where: {
        organizationId: this.organizationId('storedCompositions'),
        key: { in: drafts.map((draft) => draft.key) },
      },
      select: { key: true, permissions: { select: { permissionKey: true } } },
    });

    return new Map(
      rows.map((row: (typeof rows)[number]) => [
        row.key,
        new Set(row.permissions.map((grant: { permissionKey: string }) => grant.permissionKey)),
      ]),
    );
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

/**
 * What moved in one role, or `null` when nothing did.
 *
 * Set difference rather than a comparison of two ordered lists: the grants come back in whatever
 * order the planner produced, and a list comparison would report every role as changed on every run
 * — which is the same as reporting none, because nobody reads a trail that says everything.
 */
const describeChange = (
  roleId: string,
  draft: SystemRoleDraft,
  before: ReadonlySet<string> | undefined,
): SystemRoleChange | null => {
  const granted = draft.permissions.filter((key) => !(before?.has(key) ?? false));
  const revoked = [...(before ?? [])].filter(
    (key) => !draft.permissions.includes(key as (typeof draft.permissions)[number]),
  );

  if (granted.length === 0 && revoked.length === 0) return null;

  return {
    roleId,
    key: draft.key,
    existedBefore: before !== undefined,
    countBefore: before?.size ?? 0,
    countAfter: draft.permissions.length,
    granted,
    revoked: revoked as (typeof draft.permissions)[number][],
  };
};
