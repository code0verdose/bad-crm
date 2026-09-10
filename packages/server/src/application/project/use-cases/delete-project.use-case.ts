import { type AclScopeResolver } from '@/application/access/use-cases/resolve-acl.query.js';
import { type ProjectMemberRepositoryPort } from '@/application/project/ports/project-member-repository.port.js';
import { type ProjectRepositoryPort } from '@/application/project/ports/project-repository.port.js';
import { projectWriteFacts } from '@/application/project/project-write-facts.util.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import { canDeleteProject } from '@/domain/project/access/project-access.policy.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

export interface DeleteProjectInput {
  readonly actor: Actor;
  readonly ipAddress: string | undefined;
  readonly projectId: string;
}

/**
 * Deleting a project — STORY-014-01, acceptance 11: the row is hidden, never removed.
 *
 * **Soft, and the memberships stay.** `projects.deleted_at` is stamped so that the trail can still
 * name the project and so that `uq_projects_org_key` — partial on `deleted_at IS NULL` — frees the
 * key. `project_members` rows are left as they are: a membership has `left_at` and is history by
 * design, and a hidden project's memberships resolve for nobody — the access reader answers `null`
 * for a deleted row, so the chain is `missing` and every request is 404 (`T-PROJ-03`). This is the
 * asymmetry `delete-team.use-case.ts` explains in the other direction: there the memberships are
 * access rather than history, so they go.
 *
 * Every live member's folded view is invalidated in the same statement, so a token minted before
 * the deletion stops trusting a seat on a project that is no longer there. The entry carries the
 * roster at the moment of deletion — readable afterwards only through a join over rows that may
 * since have been ended — and is filed at `WARNING` behind a `dangerous` key, so it never degrades.
 */
export class DeleteProjectUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly projects: ProjectRepositoryPort,
    private readonly members: ProjectMemberRepositoryPort,
    private readonly acl: AclScopeResolver,
    private readonly audit: AuditLoggerPort,
  ) {}

  execute(input: DeleteProjectInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const facts = projectWriteFacts(this.projects, this.acl, input.actor, input.projectId);

        assertAllowed(await canDeleteProject(input.actor, facts.read), 'project');

        const before = facts.locked();
        const roster = await this.members.roster(input.projectId);
        const hidden = await this.projects.softDelete(input.projectId);

        // Hidden by somebody else between the lock and this write — unreachable on a real database,
        // and the same answer as for a project of another organization all the same.
        if (!hidden) throw denyAccess('project', 'other_organization');

        // One statement for everybody, not a loop (`delete-team.use-case.ts` gives the arithmetic).
        await this.members.bumpPermissionsVersionOf(roster.map((member) => member.userId));

        await this.audit.record({
          action: 'project.deleted',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: input.ipAddress,
          },
          target: { type: 'PROJECT', id: input.projectId },
          before: {
            key: before.key,
            name: before.name,
            members: roster.map((member) => ({
              userId: member.userId,
              projectRole: member.projectRole,
            })),
          },
          requestId: undefined,
        });
      },
    );
  }
}
