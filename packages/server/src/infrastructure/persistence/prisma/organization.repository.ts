import {
  type OrganizationDraft,
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
   * Writes the row with the id of the current scope.
   *
   * That is the only value that can be written. `organizations` is the tenant root: its policy is
   * `WITH CHECK (id = current_setting('app.organization_id')::uuid)`, so any other id is refused by
   * the database. Taking it from the scope rather than from the caller means the refusal is
   * unreachable, and — more usefully — that a caller cannot create an organization other than the
   * one it declared it was acting as.
   *
   * A duplicate `slug` surfaces as `organization_already_exists` through the base class. It cannot
   * be detected any other way: `slug` is globally unique, but a `SELECT ... WHERE slug = $1` runs
   * under the policy of an organization that does not exist yet and always returns nothing. The
   * unique index is the only observer of a collision — which is also why it must stay non-partial.
   */
  create(draft: OrganizationDraft): Promise<OrganizationSummary> {
    return this.run('create', async (tx) => {
      const row = await tx.organization.create({
        data: {
          id: this.organizationId('create'),
          name: draft.name,
          slug: draft.slug,
          timezone: draft.timezone,
          defaultCurrency: draft.defaultCurrency,
        },
      });

      return toOrganizationSummary(row);
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
