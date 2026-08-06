import { SharedPermissions } from '@bad-crm/shared';

import {
  type CustomRoleRepositoryPort,
  type RoleComposition,
  type RoleDraft,
  type RoleListEntry,
} from '@/application/iam/ports/role-repository.port.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

/**
 * Custom roles through Prisma, inside the scope the caller opened.
 *
 * **Grants are replaced, never merged.** A permission the draft no longer names has to disappear
 * from the role, and a merge would leave it granted for ever — the screen would say «removed» while
 * the person still had it. The same rule the system-role provisioning follows, for the same reason,
 * with the opposite trigger: there a release changes the composition, here an administrator does.
 *
 * `create` lets the unique index answer the duplicate: reading first and then inserting is two
 * statements racing each other, and the second one loses in a way the caller cannot distinguish from
 * success. `TenantScopedRepository.run` translates the violation into `role_already_exists`.
 */
/**
 * An assignment that is in force: no expiry, or one that has not passed.
 *
 * A function, not a constant: a constant would read the clock once at import and then compare every
 * later query against the moment the process started — the kind of expression that is right in a
 * test run and wrong in a server that stays up for a week.
 */
const effectiveAssignment = (): { OR: [{ expiresAt: null }, { expiresAt: { gt: Date } }] } => ({
  OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
});

export class PrismaCustomRoleRepository
  extends TenantScopedRepository
  implements CustomRoleRepositoryPort
{
  protected readonly resource = 'role' as const;
  protected readonly repositoryName = 'CustomRoleRepository';

  list(): Promise<readonly RoleListEntry[]> {
    return this.run('list', async (tx) => {
      const rows = await tx.role.findMany({
        where: { organizationId: this.organizationId('list') },
        // The order the interface shows them in: a system role outranks a custom one by priority, and
        // two roles of the same rank read alphabetically rather than in insertion order.
        orderBy: [{ priority: 'desc' }, { key: 'asc' }],
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          isSystem: true,
          isDefault: true,
          permissions: { select: { permissionKey: true } },
          // The same expiry predicate as every other read of an assignment: a grant that ran out
          // grants nothing, and counting it would tell the screen more people are affected than are.
          _count: { select: { holders: { where: effectiveAssignment() } } },
        },
      });

      return rows.map((row) => ({
        roleId: row.id,
        key: row.key,
        name: row.name,
        description: row.description,
        isSystem: row.isSystem,
        isDefault: row.isDefault,
        holderCount: row._count.holders,
        permissions: row.permissions.map(
          (grant) => grant.permissionKey as SharedPermissions.PermissionKey,
        ),
      }));
    });
  }

  compositionsOf(roleIds: readonly string[]): Promise<readonly RoleComposition[]> {
    return this.run('compositionsOf', async (tx) => {
      if (roleIds.length === 0) return [];

      const rows = await tx.role.findMany({
        where: { organizationId: this.organizationId('compositionsOf'), id: { in: [...roleIds] } },
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          isSystem: true,
          permissions: { select: { permissionKey: true } },
        },
      });

      return rows.map((row) => ({
        roleId: row.id,
        key: row.key,
        name: row.name,
        description: row.description,
        isSystem: row.isSystem,
        permissions: row.permissions
          .map((grant) => grant.permissionKey)
          .filter((key): key is SharedPermissions.PermissionKey =>
            SharedPermissions.isPermissionKey(key),
          ),
      }));
    });
  }

  holdingsOf(userId: string): Promise<{
    readonly byRole: ReadonlyMap<string, readonly SharedPermissions.PermissionKey[]>;
    readonly fromOverrides: ReadonlySet<SharedPermissions.PermissionKey>;
  }> {
    return this.run('holdingsOf', async (tx) => {
      const organizationId = this.organizationId('holdingsOf');
      const [assignments, allowed] = await Promise.all([
        tx.userRole.findMany({
          where: { organizationId, userId, ...effectiveAssignment() },
          select: {
            roleId: true,
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
        tx.userPermissionOverride.findMany({
          where: { organizationId, userId, effect: 'ALLOW', ...effectiveAssignment() },
          select: { permissionKey: true },
        }),
      ]);

      const byRole = new Map<string, readonly SharedPermissions.PermissionKey[]>(
        assignments.map((assignment) => [
          assignment.roleId,
          assignment.role.permissions
            .map((grant) => grant.permissionKey)
            .filter((key): key is SharedPermissions.PermissionKey =>
              SharedPermissions.isPermissionKey(key),
            ),
        ]),
      );

      return {
        byRole,
        fromOverrides: new Set(
          allowed
            .map((override) => override.permissionKey)
            .filter((key): key is SharedPermissions.PermissionKey =>
              SharedPermissions.isPermissionKey(key),
            ),
        ),
      };
    });
  }

  holderCounts(roleIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    return this.run('holderCounts', async (tx) => {
      if (roleIds.length === 0) return new Map<string, number>();

      // One grouped statement rather than a count per role: a draft spans several roles, and the
      // screen shows «how many people this affects» beside each of them at once.
      const rows = await tx.userRole.groupBy({
        by: ['roleId'],
        where: {
          organizationId: this.organizationId('holderCounts'),
          roleId: { in: [...roleIds] },
          ...effectiveAssignment(),
        },
        _count: { userId: true },
      });

      return new Map(rows.map((row) => [row.roleId, row._count.userId]));
    });
  }

  composition(roleId: string): Promise<RoleComposition | null> {
    return this.run('composition', async (tx) => {
      const role = await tx.role.findFirst({
        where: { organizationId: this.organizationId('composition'), id: roleId },
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          isSystem: true,
          permissions: { select: { permissionKey: true } },
        },
      });

      if (role === null) return null;

      return {
        roleId: role.id,
        key: role.key,
        name: role.name,
        description: role.description,
        isSystem: role.isSystem,
        permissions: role.permissions.map(
          (grant) => grant.permissionKey as SharedPermissions.PermissionKey,
        ),
      };
    });
  }

  create(draft: RoleDraft): Promise<string> {
    return this.run('create', async (tx) => {
      const organizationId = this.organizationId('create');
      const role = await tx.role.create({
        data: {
          organizationId,
          key: draft.key,
          name: draft.name,
          description: draft.description,
          isSystem: false,
          isDefault: false,
          permissions: {
            create: draft.permissions.map((permissionKey) => ({ organizationId, permissionKey })),
          },
        },
        select: { id: true },
      });

      return role.id;
    });
  }

  update(roleId: string, draft: Omit<RoleDraft, 'key'>): Promise<boolean> {
    return this.run('update', async (tx) => {
      const organizationId = this.organizationId('update');

      const touched = await tx.role.updateMany({
        where: { organizationId, id: roleId },
        data: { name: draft.name, description: draft.description },
      });

      // The role was read a moment ago and is gone now. Writing the grants anyway would either
      // violate the foreign key — a 500 for what is a 404 — or, for an empty composition, succeed
      // silently and file a trail entry about a role that does not exist.
      if (touched.count === 0) return false;

      // Replace, not merge — see the class comment. Both statements are in the caller's transaction,
      // so a role is never briefly without its grants as far as anybody else can see.
      await tx.rolePermission.deleteMany({ where: { organizationId, roleId } });
      await tx.rolePermission.createMany({
        data: draft.permissions.map((permissionKey) => ({
          organizationId,
          roleId,
          permissionKey,
        })),
      });

      return true;
    });
  }

  remove(roleId: string): Promise<void> {
    return this.run('remove', async (tx) => {
      // The grants and the assignments follow by `ON DELETE CASCADE`; the version bump of the people
      // who held it is the caller's job, because only the use-case knows it happened.
      await tx.role.deleteMany({
        where: { organizationId: this.organizationId('remove'), id: roleId },
      });
    });
  }

  holdsRole(userId: string, roleId: string): Promise<boolean> {
    return this.run('holdsRole', async (tx) => {
      // Expired assignments are excluded here too, and the reason is sharper than tidiness: this
      // answer feeds the self-lockout rule, which compares it against permissions the actor keeps
      // elsewhere — and that read already excludes them. Two different predicates would refuse a
      // legitimate edit on the strength of a grant that stopped applying yesterday.
      const held = await tx.userRole.findFirst({
        where: {
          organizationId: this.organizationId('holdsRole'),
          userId,
          roleId,
          ...effectiveAssignment(),
        },
        select: { userId: true },
      });

      return held !== null;
    });
  }

  holderCount(roleId: string): Promise<number> {
    return this.run('holderCount', async (tx) =>
      tx.userRole.count({
        where: {
          organizationId: this.organizationId('holderCount'),
          roleId,
          ...effectiveAssignment(),
        },
      }),
    );
  }

  permissionsExcludingRole(
    userId: string,
    roleId: string,
  ): Promise<readonly SharedPermissions.PermissionKey[]> {
    return this.run('permissionsExcludingRole', async (tx) => {
      const organizationId = this.organizationId('permissionsExcludingRole');
      const [assignments, allowed] = await Promise.all([
        tx.userRole.findMany({
          where: { organizationId, userId, roleId: { not: roleId }, ...effectiveAssignment() },
          select: {
            role: {
              select: {
                permissions: {
                  // A key retired from the catalogue grants nothing, so it is not a reason to
                  // believe somebody keeps a right — the same filter the effective-permission
                  // reader applies, for the same reason.
                  where: { permission: { deprecatedAt: null } },
                  select: { permissionKey: true },
                },
              },
            },
          },
        }),
        // ALLOW overrides count as «kept elsewhere» too: the effective set is roles **and**
        // overrides, and reading only the roles refuses a legitimate edit to somebody whose right
        // to make it came from an exception written for exactly that reason.
        tx.userPermissionOverride.findMany({
          where: { organizationId, userId, effect: 'ALLOW', ...effectiveAssignment() },
          select: { permissionKey: true },
        }),
      ]);

      // Filtered rather than cast, as the effective-permission reader does: a key outside the
      // closed catalogue is a row this code has no business believing, and `Set<PermissionKey>` is
      // exactly the place where a cast stops being checked by anything.
      return [
        ...assignments.flatMap((row) => row.role.permissions.map((grant) => grant.permissionKey)),
        ...allowed.map((override) => override.permissionKey),
      ].filter((key): key is SharedPermissions.PermissionKey =>
        SharedPermissions.isPermissionKey(key),
      );
    });
  }

  bumpHoldersOfMany(roleIds: readonly string[]): Promise<void> {
    return this.run('bumpHoldersOfMany', async (tx) => {
      if (roleIds.length === 0) return;

      const organizationId = this.organizationId('bumpHoldersOfMany');

      // `= ANY($n)` rather than a statement per role: sixty-four round trips inside a transaction
      // with a five-second ceiling is a save that fails on arithmetic rather than on anything being
      // wrong.
      //
      // It also narrows the deadlock window, and the honest version of why is narrower than it
      // looks: one statement means one lock phase instead of sixty-four interleaved ones. The order
      // **within** it is PostgreSQL's — an `ORDER BY` in the subquery does not decide the order the
      // outer `UPDATE` takes row locks in, and claiming it did would be a comment that stops
      // somebody from looking for the real fix (a deterministic order needs `ORDER BY` on the
      // update's own scan, which `UPDATE` does not take, or serialisable isolation with a retry).
      await tx.$executeRaw`
        UPDATE users
           SET permissions_version = permissions_version + 1
         WHERE organization_id = ${organizationId}::uuid
           AND id IN (
                 SELECT user_id
                   FROM user_roles
                  WHERE organization_id = ${organizationId}::uuid
                    AND role_id = ANY(${[...roleIds]}::uuid[])
                    AND (expires_at IS NULL OR expires_at > now())
               )`;
    });
  }

  bumpHoldersOf(roleId: string): Promise<void> {
    return this.run('bumpHoldersOf', async (tx) => {
      const organizationId = this.organizationId('bumpHoldersOf');

      // A subquery, so «who holds this role» is evaluated by the same statement that invalidates
      // them. Reading the holders first and updating those ids leaves a gap: somebody assigned the
      // role in between gets the new permissions and a token that still says otherwise.
      await tx.$executeRaw`
        UPDATE users
           SET permissions_version = permissions_version + 1
         WHERE organization_id = ${organizationId}::uuid
           AND id IN (
                 SELECT user_id
                   FROM user_roles
                  WHERE organization_id = ${organizationId}::uuid
                    AND role_id = ${roleId}::uuid
                    AND (expires_at IS NULL OR expires_at > now())
               )`;
    });
  }
}
