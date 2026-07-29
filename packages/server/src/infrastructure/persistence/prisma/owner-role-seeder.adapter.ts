import { type RoleSeederPort } from '@/application/identity/ports/role-seeder.port.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

/**
 * The bootstrap half of "the owner ends up holding the owner role".
 *
 * **What this writes today: `organizations.owner_id`.** The `Role` and `UserRole` tables of
 * `docs/architecture/data-model.md` — which roles exist, and which permissions each carries — belong
 * to [EPIC-011], and the port says so in its own header: the bootstrap "must not have an opinion
 * about it beyond *the owner ends up holding the owner role*". That sentence is exactly what the
 * column records, and it is the part an installation cannot start without: an organization whose
 * owner is nobody is an organization nobody can administer, and no later epic can work out who it
 * should have been.
 *
 * When EPIC-011 creates the role tables, this adapter gains the two inserts and keeps the column —
 * the ownership of an organization is a fact about the organization, not a row in a join table that
 * a permission edit could remove.
 */
export class PrismaOwnerRoleSeeder extends TenantScopedRepository implements RoleSeederPort {
  protected readonly resource = 'organization' as const;
  protected readonly repositoryName = 'OwnerRoleSeeder';

  /**
   * `updateMany` and not `update`: under the policy this can only ever match the organization of the
   * scope, so naming its id would state the same condition twice — and `update` raising `P2025` for
   * a row the policy hid would translate into a 404 for the tenant being created.
   */
  async seedSystemRoles(ownerUserId: string): Promise<void> {
    await this.run('seedSystemRoles', (tx) =>
      tx.organization.updateMany({ where: { deletedAt: null }, data: { ownerId: ownerUserId } }),
    );
  }
}
