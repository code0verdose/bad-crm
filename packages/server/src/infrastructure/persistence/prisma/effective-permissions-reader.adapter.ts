import { SharedPermissions } from '@bad-crm/shared';

import {
  type AttributedCapabilityFacts,
  type CapabilityFacts,
  type EffectivePermissionsReaderPort,
  type HeldRole,
  type OverrideFacts,
} from '@/application/iam/ports/effective-permissions-reader.port.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';
import { type TxClient } from '@/infrastructure/persistence/prisma/tenant.context.js';

/** What one read of the permission tables returns, before anything is folded out of it. */
interface PermissionRows {
  readonly permissionsVersion: number;
  readonly isOwner: boolean;
  readonly assignments: readonly {
    readonly role: {
      readonly id: string;
      readonly key: string;
      readonly name: string;
      readonly permissions: readonly { readonly permissionKey: string }[];
    };
  }[];
  readonly overrides: readonly {
    readonly permissionKey: string;
    readonly effect: 'ALLOW' | 'DENY';
    readonly reason: string;
    readonly grantedById: string | null;
    readonly grantedAt: Date;
    readonly expiresAt: Date | null;
  }[];
}

/**
 * What one person may do, assembled from their roles.
 *
 * Three properties of this read are load-bearing:
 *
 * **Expiry is a predicate.** `expiresAt IS NULL OR expiresAt > <now>` filters the assignments here,
 * not in a cleanup job: a temporary role has to stop granting at its expiry, not at the next run of
 * something nobody watches. `<now>` is `new Date()` — the application clock at the moment the
 * predicate is built, handed to Prisma as a value — and deliberately not a database-computed `now()`:
 * every predicate in this file goes through the query builder rather than raw SQL, and the query
 * builder has no way to say "compare against the server's clock" other than sending it one. The two
 * clocks agree closely enough for this deployment shape (one Node process and one Postgres, usually
 * one Docker Compose host) that the difference has no operational meaning; it does mean the predicate
 * cannot be pinned to a single statement snapshot the way a literal `now()` in SQL would be, which
 * this endpoint does not need — it already accepts a window of up to a cache TTL before an expiry
 * takes effect (§5, edge case 1 of `permission-model.md`).
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
 * **Overrides are read here too**, and the same expiry predicate applies to them: an exception that
 * expired a second ago grants and denies nothing, whether or not the cleaner has run. ALLOW joins
 * the grants; DENY is returned separately, because «refused by an exception» and «never granted» are
 * different answers with different remedies.
 *
 * **Both public methods read through `rows` and fold through `toFacts`.** The administration screen
 * needs the same facts with their origin attached, and the tempting shape — a second query written
 * for that screen — is how a product ends up explaining a decision it did not make: the two would
 * agree until somebody changed one predicate, and the screen would then reassure an administrator
 * about a permission the guard refuses. So the predicates exist once and the extra columns cost the
 * hot path a few bytes per role.
 */
export class PrismaEffectivePermissionsReader
  extends TenantScopedRepository
  implements EffectivePermissionsReaderPort
{
  protected readonly resource = 'user' as const;
  protected readonly repositoryName = 'EffectivePermissionsReader';

  capabilitiesOf(userId: string): Promise<CapabilityFacts | null> {
    return this.run('capabilitiesOf', async (tx) => {
      const rows = await this.rows(tx, userId, 'capabilitiesOf');

      return rows === null ? null : toFacts(rows);
    });
  }

  attributedCapabilitiesOf(userId: string): Promise<AttributedCapabilityFacts | null> {
    return this.run('attributedCapabilitiesOf', async (tx) => {
      const rows = await this.rows(tx, userId, 'attributedCapabilitiesOf');

      return rows === null ? null : attribute(rows);
    });
  }

  private async rows(
    tx: TxClient,
    userId: string,
    operation: string,
  ): Promise<PermissionRows | null> {
    const organizationId = this.organizationId(operation);

    const user = await tx.user.findFirst({
      where: { organizationId, id: userId, deletedAt: null },
      select: { id: true, permissionsVersion: true },
    });

    if (user === null) return null;

    const unexpired = { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] };

    const [organization, assignments, overrides] = await Promise.all([
      tx.organization.findFirst({ where: { id: organizationId }, select: { ownerId: true } }),
      tx.userRole.findMany({
        where: { organizationId, userId, ...unexpired },
        select: {
          role: {
            select: {
              id: true,
              key: true,
              name: true,
              permissions: {
                where: { permission: { deprecatedAt: null } },
                select: { permissionKey: true },
              },
            },
          },
        },
      }),
      tx.userPermissionOverride.findMany({
        where: { organizationId, userId, ...unexpired },
        select: {
          permissionKey: true,
          effect: true,
          reason: true,
          grantedById: true,
          grantedAt: true,
          expiresAt: true,
        },
      }),
    ]);

    return {
      permissionsVersion: user.permissionsVersion,
      isOwner: organization?.ownerId === userId,
      assignments,
      overrides,
    };
  }
}

/** The fold the decision is made from — roles and ALLOW exceptions in, DENY exceptions apart. */
const toFacts = (rows: PermissionRows): CapabilityFacts => {
  const granted = new Set<SharedPermissions.PermissionKey>();
  const denied = new Set<SharedPermissions.PermissionKey>();

  for (const assignment of rows.assignments) {
    for (const grant of assignment.role.permissions) {
      if (SharedPermissions.isPermissionKey(grant.permissionKey)) granted.add(grant.permissionKey);
    }
  }

  for (const override of rows.overrides) {
    if (!SharedPermissions.isPermissionKey(override.permissionKey)) continue;

    if (override.effect === 'ALLOW') granted.add(override.permissionKey);
    else denied.add(override.permissionKey);
  }

  return {
    isOwner: rows.isOwner,
    granted: [...granted],
    denied: [...denied],
    roleKeys: rows.assignments.map((assignment) => assignment.role.key),
    permissionsVersion: rows.permissionsVersion,
  };
};

/** The same fold, with the origin of each part kept beside it instead of thrown away. */
const attribute = (rows: PermissionRows): AttributedCapabilityFacts => {
  const grantedByRole = new Map<SharedPermissions.PermissionKey, string[]>();
  const overrides = new Map<SharedPermissions.PermissionKey, OverrideFacts>();
  const roles: HeldRole[] = [];

  for (const assignment of rows.assignments) {
    roles.push({
      roleId: assignment.role.id,
      key: assignment.role.key,
      name: assignment.role.name,
    });

    for (const grant of assignment.role.permissions) {
      if (!SharedPermissions.isPermissionKey(grant.permissionKey)) continue;

      const holders = grantedByRole.get(grant.permissionKey);

      if (holders === undefined) grantedByRole.set(grant.permissionKey, [assignment.role.id]);
      else holders.push(assignment.role.id);
    }
  }

  for (const override of rows.overrides) {
    if (!SharedPermissions.isPermissionKey(override.permissionKey)) continue;

    overrides.set(override.permissionKey, {
      effect: override.effect,
      reason: override.reason,
      grantedById: override.grantedById,
      grantedAt: override.grantedAt,
      expiresAt: override.expiresAt,
    });
  }

  return { facts: toFacts(rows), roles, grantedByRole, overrides };
};
