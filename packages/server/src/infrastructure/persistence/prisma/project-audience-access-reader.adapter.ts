import { type SharedPermissions } from '@bad-crm/shared';
import { Prisma } from '@prisma/client';

import {
  type ProjectAudienceAccessReaderPort,
  type ProjectGrantFacts,
  type ProjectSeatFacts,
} from '@/application/access/ports/project-audience-access-reader.port.js';
import { type ProjectRole } from '@/domain/access/implicit-level.policy.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

interface SeatRow {
  readonly user_id: string;
  readonly member_role: ProjectRole | null;
}

interface GrantRow {
  readonly user_id: string;
  readonly depth: number;
  readonly level: SharedPermissions.AccessLevel;
  readonly expires_at: Date | null;
}

/**
 * The audience of one project — every active account of the organization, its seat, and the grants
 * on the chain that reach it — in two statements. The number of statements does not grow with the
 * organization; the rows read are O(N) in its accounts, and grouping them is the caller's, in one
 * pass (`groupBy`), not a filter per person.
 *
 * **The per-person readers, restated for a set, and held to them.** The seat is
 * `PrismaProjectAccessReader.aclFacts` (live membership, `left_at IS NULL`) as a `LEFT JOIN` from
 * the accounts; the grants are `PrismaAclReader.entriesAlong` with the person turned from a bound
 * value into a joined column — the same three subject branches (the person, an unexpired role
 * assignment, a team membership), the same expiry predicate, the same leading tenant column of
 * `uq_resource_acl`. What makes this a restatement rather than a second rule is
 * `test/integration/db/project-visibility-impact.test.ts`: the answer built from these two reads
 * is compared, colleague by colleague, with the per-person read decision on a live database.
 *
 * **The audience is active, undeleted accounts** (`status = 'ACTIVE' AND deleted_at IS NULL`) —
 * the port's docstring gives the reason. The chain is `PROJECT (0) → ORGANIZATION (1)`, built from
 * the tenant the caller opened; the project's existence is not checked here, because the policy has
 * already decided it before this is read.
 *
 * Rows come back unreduced: the closest-node, `NONE` and maximum rules are
 * `acl-resolution.policy.ts`'s, applied per person by the domain.
 */
export class PrismaProjectAudienceAccessReader
  extends TenantScopedRepository
  implements ProjectAudienceAccessReaderPort
{
  protected readonly resource = 'project' as const;
  protected readonly repositoryName = 'ProjectAudienceAccessReader';

  seatsOf(projectId: string): Promise<readonly ProjectSeatFacts[]> {
    return this.run('seatsOf', async (tx) => {
      const organizationId = this.organizationId('seatsOf');
      const rows = await tx.$queryRaw<SeatRow[]>(Prisma.sql`
        SELECT u.id            AS user_id,
               pm.project_role AS member_role
          FROM users u
          LEFT JOIN project_members pm
            ON pm.organization_id = u.organization_id
           AND pm.project_id      = ${projectId}::uuid
           AND pm.user_id         = u.id
           AND pm.left_at IS NULL
         WHERE u.organization_id = ${organizationId}::uuid
           AND u.status          = 'ACTIVE'
           AND u.deleted_at IS NULL
         ORDER BY u.id`);

      return rows.map((row) => ({ userId: row.user_id, memberRole: row.member_role }));
    });
  }

  grantsOn(projectId: string): Promise<readonly ProjectGrantFacts[]> {
    return this.run('grantsOn', async (tx) => {
      const organizationId = this.organizationId('grantsOn');
      const rows = await tx.$queryRaw<GrantRow[]>(Prisma.sql`
        WITH chain(depth, resource_type, resource_id) AS (
               VALUES (0::int, 'PROJECT'::acl_resource_type, ${projectId}::uuid),
                      (1::int, 'ORGANIZATION'::acl_resource_type, ${organizationId}::uuid))
        SELECT u.id                 AS user_id,
               c.depth              AS depth,
               a.access_level::text AS level,
               a.expires_at         AS expires_at
          FROM chain c
          JOIN resource_acl a
            ON a.organization_id = ${organizationId}::uuid
           AND a.resource_type   = c.resource_type
           AND a.resource_id     = c.resource_id
          JOIN users u
            ON u.organization_id = ${organizationId}::uuid
           AND u.status          = 'ACTIVE'
           AND u.deleted_at IS NULL
         WHERE (a.expires_at IS NULL OR a.expires_at > now())
           AND (
                 (a.subject_type = 'USER' AND a.subject_id = u.id)
              OR (a.subject_type = 'ROLE' AND EXISTS (
                    SELECT 1
                      FROM user_roles ur
                     WHERE ur.organization_id = ${organizationId}::uuid
                       AND ur.user_id = u.id
                       AND ur.role_id = a.subject_id
                       AND (ur.expires_at IS NULL OR ur.expires_at > now())))
              OR (a.subject_type = 'TEAM' AND EXISTS (
                    SELECT 1
                      FROM team_members tm
                     WHERE tm.organization_id = ${organizationId}::uuid
                       AND tm.user_id = u.id
                       AND tm.team_id = a.subject_id))
               )
         ORDER BY u.id, c.depth`);

      return rows.map((row) => ({
        userId: row.user_id,
        depth: row.depth,
        level: row.level,
        expiresAt: row.expires_at,
      }));
    });
  }
}
