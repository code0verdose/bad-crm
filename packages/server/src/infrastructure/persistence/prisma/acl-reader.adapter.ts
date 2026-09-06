import { type SharedPermissions } from '@bad-crm/shared';
import { Prisma } from '@prisma/client';

import { type AclReaderPort } from '@/application/access/ports/acl-reader.port.js';
import { type AclChainNode, type AclEntryOnChain } from '@/domain/access/acl-chain.types.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

interface EntryRow {
  readonly depth: number;
  readonly level: SharedPermissions.AccessLevel;
  readonly expires_at: Date | null;
}

/**
 * `resolve-acl.query.sql` of the model, as one statement (`docs/security/permission-model.md`,
 * «Как это выполняется в БД»; STORY-011-06, acceptance 8).
 *
 * The chain arrives as a `VALUES` list tagged with depth and is joined against `resource_acl` on
 * `(organization_id, resource_id)` plus `resource_type` — and the order matters more here than in
 * most tables: `enum_eq` is not leakproof, so under row-level security the type equality can only
 * be a filter for `app_user`, never an index condition, and `uq_resource_acl` therefore leads
 * with `organization_id, resource_id` (the migration records the measurement). The tenant
 * predicate is written into the join although the policy would apply it anyway, because it is the
 * first column of that index; without it the lookup has no leading column and is a scan.
 *
 * **The subjects are matched inside the statement.** A person matches their own `USER` rows, the
 * `ROLE` rows of every unexpired assignment they hold, and the `TEAM` rows of every team they are
 * on. Resolving those sets here rather than in the caller is what keeps the round trip at one: a
 * port that took role and team ids would have made its caller spend two queries fetching them.
 *
 * **What comes back is unreduced.** `ORDER BY depth` is the only thing the database contributes to
 * the decision; the closest-node, `NONE` and maximum rules are applied by
 * `domain/access/acl-resolution.policy.ts` over these rows, so the rules live once, in a pure
 * function with a table test. The doc's `GROUP BY … LIMIT 1` sketch would have put half of rule 2
 * into SQL and half into code. Expiry is filtered here as well — not through an index (`expires_at`
 * is not in the one the join uses; the expired rows of an object are read and dropped by the
 * filter, a handful per object) but so that the rows the policy sees are the rows a query of the
 * table would show — and again by the policy, where it is the rule.
 */
export class PrismaAclReader extends TenantScopedRepository implements AclReaderPort {
  protected readonly resource = 'organization' as const;
  protected readonly repositoryName = 'AclReader';

  entriesAlong(
    chain: readonly AclChainNode[],
    userId: string,
  ): Promise<readonly AclEntryOnChain[]> {
    return this.run('entriesAlong', async (tx) => {
      if (chain.length === 0) return [];

      const organizationId = this.organizationId('entriesAlong');
      const nodes = Prisma.join(
        chain.map(
          (node) =>
            Prisma.sql`(${node.depth}::int, ${node.type}::acl_resource_type, ${node.id}::uuid)`,
        ),
      );

      const rows = await tx.$queryRaw<EntryRow[]>(Prisma.sql`
        WITH chain(depth, resource_type, resource_id) AS (VALUES ${nodes})
        SELECT c.depth              AS depth,
               a.access_level::text AS level,
               a.expires_at         AS expires_at
          FROM chain c
          JOIN resource_acl a
            ON a.organization_id = ${organizationId}::uuid
           AND a.resource_type   = c.resource_type
           AND a.resource_id     = c.resource_id
         WHERE (a.expires_at IS NULL OR a.expires_at > now())
           AND (
                 (a.subject_type = 'USER' AND a.subject_id = ${userId}::uuid)
              OR (a.subject_type = 'ROLE' AND a.subject_id IN (
                    SELECT ur.role_id
                      FROM user_roles ur
                     WHERE ur.user_id = ${userId}::uuid
                       AND (ur.expires_at IS NULL OR ur.expires_at > now())))
              OR (a.subject_type = 'TEAM' AND a.subject_id IN (
                    SELECT tm.team_id
                      FROM team_members tm
                     WHERE tm.user_id = ${userId}::uuid))
               )
         ORDER BY c.depth`);

      return rows.map((row) => ({
        depth: row.depth,
        level: row.level,
        expiresAt: row.expires_at,
      }));
    });
  }
}
