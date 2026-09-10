import {
  type ProjectDetail,
  type ProjectDraft,
  type ProjectListEntry,
  type ProjectPatch,
  type ProjectRepositoryPort,
} from '@/application/project/ports/project-repository.port.js';
import { type ProjectScope, type ProjectSummary } from '@/domain/project/project.entity.js';
import { type ProjectStatus, type ProjectVisibility } from '@/domain/project/project.enums.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

/**
 * Projects through Prisma, inside the scope the caller opened.
 *
 * **The list filters deleted rows and the reads by id do not** — the same split `team.repository.ts`
 * makes, for the same reason: a list showing a deleted project is wrong, and a read by id that
 * filtered in SQL would take the 404 decision away from the policy.
 *
 * **Every write carries `deletedAt: null`.** A deleted project must not be editable, and a rename
 * without the predicate would resurrect a key conflict against a live project.
 *
 * **`scope()` reads under `FOR SHARE`.** A membership written later in the same transaction must
 * not land on a project a concurrent `softDelete` has just hidden; the share lock makes one of the
 * two wait for the other (the M-1 pattern of the team repository).
 *
 * **`status`, `visibility` are read back as their closed types.** The columns are `TEXT` held by
 * `ck_projects_status` / `ck_projects_visibility`, so the narrowing states the constraint rather
 * than assumes it; the migration and `project.enums.ts` are held together by a unit test.
 */
export class PrismaProjectRepository
  extends TenantScopedRepository
  implements ProjectRepositoryPort
{
  protected readonly resource = 'project' as const;
  protected readonly repositoryName = 'ProjectRepository';

  list(): Promise<readonly ProjectListEntry[]> {
    return this.run('list', async (tx) => {
      const rows = await tx.project.findMany({
        where: { organizationId: this.organizationId('list'), deletedAt: null },
        orderBy: { key: 'asc' },
        select: {
          id: true,
          key: true,
          name: true,
          status: true,
          visibility: true,
          leadId: true,
          color: true,
          _count: { select: { members: { where: { leftAt: null } } } },
        },
      });

      return rows.map((row) => ({
        projectId: row.id,
        key: row.key,
        name: row.name,
        status: row.status as ProjectStatus,
        visibility: row.visibility as ProjectVisibility,
        leadId: row.leadId,
        color: row.color,
        memberCount: row._count.members,
      }));
    });
  }

  scope(projectId: string): Promise<ProjectScope | null> {
    return this.run('scope', async (tx) => {
      // No `deleted_at IS NULL`: the policy decides what a deleted project answers. `FOR SHARE`, held
      // for the rest of the transaction, so a membership written on the strength of this read cannot
      // land on a project `softDelete` hides in between.
      const rows = await tx.$queryRaw<
        { id: string; deleted_at: Date | null; visibility: string }[]
      >`
        SELECT id, deleted_at, visibility FROM projects
         WHERE organization_id = ${this.organizationId('scope')}::uuid
           AND id = ${projectId}::uuid
         FOR SHARE`;

      const row = rows[0];

      if (row === undefined) return null;

      return {
        projectId: row.id,
        isDeleted: row.deleted_at !== null,
        visibility: row.visibility as ProjectVisibility,
      };
    });
  }

  lockForWrite(projectId: string): Promise<ProjectSummary | null> {
    return this.run('lockForWrite', async (tx) => {
      // `FOR UPDATE`, and not the share lock `scope()` takes: this is the first statement of every
      // mutation, and a writer that started with `FOR SHARE` would have to upgrade it under its own
      // `UPDATE` — the deadlock of two concurrent edits of one project. No `deleted_at IS NULL`, as
      // in `scope()`: the policy decides what a deleted row answers.
      const rows = await tx.$queryRaw<
        {
          id: string;
          key: string;
          name: string;
          description: string | null;
          status: string;
          visibility: string;
          lead_id: string;
          started_at: Date | null;
          due_at: Date | null;
          color: string;
          deleted_at: Date | null;
        }[]
      >`
        SELECT id, key, name, description, status, visibility, lead_id, started_at, due_at, color,
               deleted_at
          FROM projects
         WHERE organization_id = ${this.organizationId('lockForWrite')}::uuid
           AND id = ${projectId}::uuid
         FOR UPDATE`;

      const row = rows[0];

      if (row === undefined) return null;

      return {
        projectId: row.id,
        isDeleted: row.deleted_at !== null,
        visibility: row.visibility as ProjectVisibility,
        key: row.key,
        name: row.name,
        description: row.description,
        status: row.status as ProjectStatus,
        leadId: row.lead_id,
        startedAt: row.started_at,
        dueAt: row.due_at,
        color: row.color,
      };
    });
  }

  detail(projectId: string): Promise<ProjectDetail | null> {
    return this.run('detail', async (tx) => {
      const row = await tx.project.findFirst({
        where: { organizationId: this.organizationId('detail'), id: projectId },
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          status: true,
          visibility: true,
          leadId: true,
          startedAt: true,
          dueAt: true,
          color: true,
          taskCounter: true,
          createdAt: true,
          deletedAt: true,
          _count: { select: { members: { where: { leftAt: null } } } },
        },
      });

      if (row === null) return null;

      return {
        projectId: row.id,
        key: row.key,
        name: row.name,
        description: row.description,
        status: row.status as ProjectStatus,
        visibility: row.visibility as ProjectVisibility,
        leadId: row.leadId,
        startedAt: row.startedAt,
        dueAt: row.dueAt,
        color: row.color,
        taskCounter: row.taskCounter,
        createdAt: row.createdAt,
        isDeleted: row.deletedAt !== null,
        memberCount: row._count.members,
      };
    });
  }

  create(draft: ProjectDraft): Promise<string> {
    return this.run('create', async (tx) => {
      const project = await tx.project.create({
        data: {
          organizationId: this.organizationId('create'),
          key: draft.key,
          name: draft.name,
          description: draft.description,
          visibility: draft.visibility,
          leadId: draft.leadId,
          startedAt: draft.startedAt,
          dueAt: draft.dueAt,
          color: draft.color,
        },
        select: { id: true },
      });

      return project.id;
    });
  }

  update(projectId: string, patch: ProjectPatch): Promise<boolean> {
    return this.run('update', async (tx) => {
      // `updateMany`, not `update`: a row that is not there is an ordinary outcome of a concurrent
      // deletion, and `update` would raise `P2025` — which the base class turns into a 404 before the
      // caller sees the outcome. `key` is not on the patch at all (STORY-014-01, acceptance 4).
      const { count } = await tx.project.updateMany({
        where: { organizationId: this.organizationId('update'), id: projectId, deletedAt: null },
        data: {
          name: patch.name,
          description: patch.description,
          leadId: patch.leadId,
          startedAt: patch.startedAt,
          dueAt: patch.dueAt,
          color: patch.color,
        },
      });

      return count > 0;
    });
  }

  changeVisibility(projectId: string, visibility: ProjectVisibility): Promise<boolean> {
    return this.run('changeVisibility', async (tx) => {
      const { count } = await tx.project.updateMany({
        where: {
          organizationId: this.organizationId('changeVisibility'),
          id: projectId,
          deletedAt: null,
        },
        data: { visibility },
      });

      return count > 0;
    });
  }

  changeStatus(projectId: string, status: ProjectStatus): Promise<boolean> {
    return this.run('changeStatus', async (tx) => {
      const { count } = await tx.project.updateMany({
        where: {
          organizationId: this.organizationId('changeStatus'),
          id: projectId,
          deletedAt: null,
        },
        data: { status },
      });

      return count > 0;
    });
  }

  softDelete(projectId: string): Promise<boolean> {
    return this.run('softDelete', async (tx) => {
      // Conditional on `deleted_at IS NULL` and stamped by the database in the same statement:
      // reading first and hiding afterwards would be two statements over a row a concurrent request
      // can delete in between, and the second caller would then file an audit entry for a deletion
      // somebody else performed.
      const hidden = await tx.$queryRaw<{ id: string }[]>`
        UPDATE projects
           SET deleted_at = now()
         WHERE organization_id = ${this.organizationId('softDelete')}::uuid
           AND id = ${projectId}::uuid
           AND deleted_at IS NULL
        RETURNING id`;

      return hidden.length > 0;
    });
  }
}
