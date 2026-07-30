import { randomUUID } from 'node:crypto';

import {
  type BootstrappedOrganization,
  type OrganizationDraft,
  type OrganizationOwnerDraft,
  type OrganizationRepositoryPort,
  type OrganizationSummary,
} from '@/application/organization/ports/organization-repository.port.js';
import { toOrganizationSummary } from '@/infrastructure/persistence/prisma/organization-row.util.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

/**
 * The tenant root, through Prisma.
 *
 * The first repository of the codebase and therefore the template for the rest: it holds no client,
 * takes no transaction, takes no `organizationId`, and reaches the database only through
 * `TenantScopedRepository.run`. Everything about *which tenant* comes from the scope opened by
 * `UnitOfWorkPort`.
 */
export class PrismaOrganizationRepository
  extends TenantScopedRepository
  implements OrganizationRepositoryPort
{
  protected readonly resource = 'organization' as const;
  protected readonly repositoryName = 'OrganizationRepository';

  /**
   * Writes the tenant root and its owner with the id of the current scope. Why one statement is in
   * the port; this is what it costs to write.
   *
   * The organization's id is the only value that can be written for it. `organizations` is the tenant
   * root: its policy is `WITH CHECK (id = current_setting('app.organization_id')::uuid)`, so any
   * other id is refused by the database. Taking it from the scope rather than from the caller means
   * the refusal is unreachable, and — more usefully — that a caller cannot create an organization
   * other than the one it declared it was acting as. The owner's id is generated here because the
   * statement needs it before either row exists.
   *
   * A duplicate `slug` surfaces as `organization_already_exists` through the base class. It cannot
   * be detected any other way: `slug` is globally unique, but a `SELECT ... WHERE slug = $1` runs
   * under the policy of an organization that does not exist yet and always returns nothing. The
   * unique index is the only observer of a collision — which is also why it must stay non-partial.
   * A duplicate owner address surfaces the same way, through `uq_users_org_email`.
   */
  createWithOwner(
    draft: OrganizationDraft,
    owner: OrganizationOwnerDraft,
  ): Promise<BootstrappedOrganization> {
    return this.run('createWithOwner', async (tx) => {
      const organizationId = this.organizationId('createWithOwner');
      const ownerId = randomUUID();

      // Raw, and one statement, because the two rows reference each other and `owner_id` is NOT NULL:
      // `organizations` needs the user's id, `users` needs the organization's. Prisma has no way to
      // express two inserts as one statement, and this is the one place raw SQL is allowed
      // (`rules/hexagonal-backend.mdc`). Foreign keys are `AFTER ROW` triggers evaluated when the
      // statement finishes, so both rows are in place before either constraint is checked — no
      // deferral, no nullable window.
      //
      // `$queryRaw` with a tagged template, so every value is a bound parameter: `slug` and `email`
      // come from the request body. The `RETURNING` of the CTE is discarded — `WITH` requires the
      // referencing insert to be the outer statement, so the organization row is written in the CTE
      // and the user row outside it.
      const rows = await tx.$queryRaw<{ organization_id: string; owner_id: string }[]>`
        WITH created_organization AS (
          INSERT INTO organizations (id, owner_id, name, slug, timezone, default_currency, updated_at)
          VALUES (${organizationId}::uuid, ${ownerId}::uuid, ${draft.name}, ${draft.slug},
                  ${draft.timezone}, ${draft.defaultCurrency}, now())
          RETURNING id
        )
        INSERT INTO users (id, organization_id, email, password_hash, locale, timezone, status,
                           updated_at)
        VALUES (${ownerId}::uuid, ${organizationId}::uuid, ${owner.email}, ${owner.passwordHash},
                ${owner.locale}, ${owner.timezone}, 'ACTIVE', now())
        RETURNING organization_id, id AS owner_id`;

      const created = rows[0];

      // `INSERT … RETURNING` produces a row or raises; an empty result would mean the policy silently
      // dropped the write, which `WITH CHECK` does not do. Asserted rather than assumed because the
      // caller's next step opens a session for this id.
      if (created === undefined) {
        throw new Error('createWithOwner wrote no row: the tenant root was not created');
      }

      return { organizationId: created.organization_id, ownerId: created.owner_id };
    });
  }

  /**
   * The organization of the current scope.
   *
   * `findFirst` with no `where` on the tenant, deliberately: the policy already restricts this
   * table to one row, so naming the id in the query would state the same condition twice — and a
   * second statement of a condition is a second thing that can be wrong. `deletedAt` is the one
   * filter the policy does not express.
   */
  findCurrent(): Promise<OrganizationSummary | null> {
    return this.run('findCurrent', async (tx) => {
      const row = await tx.organization.findFirst({ where: { deletedAt: null } });

      return row === null ? null : toOrganizationSummary(row);
    });
  }
}
