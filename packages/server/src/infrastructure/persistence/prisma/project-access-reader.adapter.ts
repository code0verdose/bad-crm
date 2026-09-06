import { Prisma } from '@prisma/client';

import {
  type ProjectAccessReaderPort,
  type ProjectAclFacts,
} from '@/application/access/ports/project-access-reader.port.js';
import { type ProjectRole, type ProjectVisibility } from '@/domain/access/implicit-level.policy.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

interface FactsRow {
  readonly organization_id: string;
  readonly visibility: ProjectVisibility;
  readonly member_role: ProjectRole | null;
}

/**
 * The project half of the implicit table, in one statement: the project's visibility and the
 * person's live membership, or nothing.
 *
 * **Written against the names of `docs/architecture/data-model.md` §3** — `projects.visibility`,
 * `projects.deleted_at`, `project_members.project_role`, `project_members.left_at` — as raw SQL
 * rather than through the generated client, because this adapter was built in the same step as
 * the tables it reads (STORY-011-06 beside EPIC-014's first story) and could not depend on a model
 * that did not yet exist in the committed schema. The step that gives the project context its own
 * access reader (STORY-014-02) is the one to fold this into it and move to the model; the
 * integration test that proves the names (`resource-acl-reader.test.ts`) is what makes that move
 * safe.
 *
 * `LEFT JOIN`, not `JOIN`: a non-member of a public project is a row with `member_role = NULL`,
 * which is exactly the «не участник, но член организации → VIEWER» row of §5. A soft-deleted
 * project is no row at all — the resolver's `missing`, a 404 — and so is a project of another
 * organization, because the policy sees neither.
 */
export class PrismaProjectAccessReader
  extends TenantScopedRepository
  implements ProjectAccessReaderPort
{
  protected readonly resource = 'project' as const;
  protected readonly repositoryName = 'ProjectAccessReader';

  aclFacts(projectId: string, userId: string): Promise<ProjectAclFacts | null> {
    return this.run('aclFacts', async (tx) => {
      const rows = await tx.$queryRaw<FactsRow[]>(Prisma.sql`
        SELECT p.organization_id AS organization_id,
               p.visibility      AS visibility,
               pm.project_role   AS member_role
          FROM projects p
          LEFT JOIN project_members pm
            ON pm.organization_id = p.organization_id
           AND pm.project_id      = p.id
           AND pm.user_id         = ${userId}::uuid
           AND pm.left_at IS NULL
         WHERE p.organization_id = ${this.organizationId('aclFacts')}::uuid
           AND p.id              = ${projectId}::uuid
           AND p.deleted_at IS NULL
         LIMIT 1`);
      const row = rows[0];

      return row === undefined
        ? null
        : {
            organizationId: row.organization_id,
            visibility: row.visibility,
            memberRole: row.member_role,
          };
    });
  }
}
