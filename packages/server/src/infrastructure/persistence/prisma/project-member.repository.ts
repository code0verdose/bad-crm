import {
  type ProjectMemberEntry,
  type ProjectMemberPatch,
  type ProjectMemberRepositoryPort,
} from '@/application/project/ports/project-member-repository.port.js';
import { type ProjectMembership, type ProjectSubject } from '@/domain/project/project.entity.js';
import { type ProjectRole } from '@/domain/project/project.enums.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

/**
 * Project membership through Prisma, inside the scope the caller opened.
 *
 * **A membership ends by `left_at`, never by `DELETE`.** The row is history and a link target
 * (`data-model.md` §3), so `leave` is a conditional `UPDATE`, and everything that means «the team»
 * reads `left_at IS NULL`.
 *
 * **`add` is `ON CONFLICT … DO NOTHING` against the partial index.** The conflict target names the
 * index predicate — `(project_id, user_id) WHERE left_at IS NULL` — because that is the only way
 * PostgreSQL can infer a partial unique index; without the clause the statement fails at parse time
 * on every call. Two concurrent adds of one pair therefore leave one row and answer `true` once.
 *
 * **`leads()` reads under `FOR UPDATE`, `subject()` under `FOR SHARE`.** The first is the database
 * half of «the last lead cannot leave»; the second closes the same TOCTOU against offboarding that
 * `team.repository.ts` documents — a `SUSPENDED` account must not end up holding a membership.
 */
export class PrismaProjectMemberRepository
  extends TenantScopedRepository
  implements ProjectMemberRepositoryPort
{
  protected readonly resource = 'project' as const;
  protected readonly repositoryName = 'ProjectMemberRepository';

  roster(
    projectId: string,
    options: { readonly includeLeft?: boolean } = {},
  ): Promise<readonly ProjectMemberEntry[]> {
    return this.run('roster', async (tx) => {
      const rows = await tx.projectMember.findMany({
        where: {
          organizationId: this.organizationId('roster'),
          projectId,
          ...(options.includeLeft === true ? {} : { leftAt: null }),
        },
        orderBy: { joinedAt: 'asc' },
        select: {
          userId: true,
          projectRole: true,
          allocationPct: true,
          joinedAt: true,
          leftAt: true,
        },
      });

      return rows.map((row) => ({
        userId: row.userId,
        projectRole: row.projectRole as ProjectRole,
        allocationPct: row.allocationPct,
        joinedAt: row.joinedAt,
        leftAt: row.leftAt,
      }));
    });
  }

  membershipOf(projectId: string, userId: string): Promise<ProjectMembership | null> {
    return this.run('membershipOf', async (tx) => {
      const row = await tx.projectMember.findFirst({
        where: {
          organizationId: this.organizationId('membershipOf'),
          projectId,
          userId,
          leftAt: null,
        },
        select: { projectRole: true, allocationPct: true },
      });

      if (row === null) return null;

      return { projectRole: row.projectRole as ProjectRole, allocationPct: row.allocationPct };
    });
  }

  leads(projectId: string): Promise<readonly string[]> {
    return this.run('leads', async (tx) => {
      // `FOR UPDATE` on the live leads, held for the rest of the transaction: a second transaction
      // counting the same leads waits here, and when it proceeds `READ COMMITTED` re-checks
      // `left_at IS NULL` against the row the first one stamped — so it counts one lead, not two.
      const rows = await tx.$queryRaw<{ user_id: string }[]>`
        SELECT user_id FROM project_members
         WHERE organization_id = ${this.organizationId('leads')}::uuid
           AND project_id = ${projectId}::uuid
           AND project_role = 'LEAD'
           AND left_at IS NULL
         FOR UPDATE`;

      return rows.map((row) => row.user_id);
    });
  }

  subject(userId: string): Promise<ProjectSubject | null> {
    return this.run('subject', async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; status: ProjectSubject['status'] }[]>`
        SELECT id, status FROM users
         WHERE organization_id = ${this.organizationId('subject')}::uuid
           AND id = ${userId}::uuid
           AND deleted_at IS NULL
         FOR SHARE`;

      const user = rows[0];

      if (user === undefined) return null;

      return { userId: user.id, status: user.status };
    });
  }

  add(
    projectId: string,
    userId: string,
    projectRole: string,
    allocationPct: number,
  ): Promise<boolean> {
    return this.run('add', async (tx) => {
      const inserted = await tx.$executeRaw`
        INSERT INTO project_members
          (organization_id, project_id, user_id, project_role, allocation_pct, updated_at)
        VALUES (${this.organizationId('add')}::uuid, ${projectId}::uuid, ${userId}::uuid,
                ${projectRole}, ${allocationPct}, now())
        ON CONFLICT (project_id, user_id) WHERE left_at IS NULL DO NOTHING`;

      return inserted > 0;
    });
  }

  update(projectId: string, userId: string, patch: ProjectMemberPatch): Promise<boolean> {
    return this.run('update', async (tx) => {
      const { count } = await tx.projectMember.updateMany({
        where: { organizationId: this.organizationId('update'), projectId, userId, leftAt: null },
        data: {
          ...(patch.projectRole === undefined ? {} : { projectRole: patch.projectRole }),
          ...(patch.allocationPct === undefined ? {} : { allocationPct: patch.allocationPct }),
        },
      });

      return count > 0;
    });
  }

  leave(projectId: string, userId: string): Promise<boolean> {
    return this.run('leave', async (tx) => {
      const ended = await tx.$executeRaw`
        UPDATE project_members
           SET left_at = now()
         WHERE organization_id = ${this.organizationId('leave')}::uuid
           AND project_id = ${projectId}::uuid
           AND user_id = ${userId}::uuid
           AND left_at IS NULL`;

      return ended > 0;
    });
  }
}
