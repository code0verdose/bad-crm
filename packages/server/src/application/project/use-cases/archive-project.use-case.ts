import { type AclScopeResolver } from '@/application/access/use-cases/resolve-acl.query.js';
import { type ProjectRepositoryPort } from '@/application/project/ports/project-repository.port.js';
import { projectWriteFacts } from '@/application/project/project-write-facts.util.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import { canArchiveProject } from '@/domain/project/access/project-access.policy.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

export interface ArchiveProjectInput {
  readonly actor: Actor;
  readonly ipAddress: string | undefined;
  readonly projectId: string;
}

/**
 * Archiving a project: `status` becomes `ARCHIVED` — STORY-014-01 names it beside deletion; the
 * confirmation on the screen, the read-only rule on an archived project and the way back are
 * STORY-014-07 and are not here.
 *
 * `project:archive`, `MANAGER`, over the locked row. Idempotent: a repeat on an archived project
 * writes nothing and files nothing, because the state the caller asked for already holds. A
 * deleted project is 404 like everywhere else — an archive is a state of a live project.
 */
export class ArchiveProjectUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly projects: ProjectRepositoryPort,
    private readonly acl: AclScopeResolver,
    private readonly audit: AuditLoggerPort,
  ) {}

  execute(input: ArchiveProjectInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const facts = projectWriteFacts(this.projects, this.acl, input.actor, input.projectId);

        assertAllowed(await canArchiveProject(input.actor, facts.read), 'project');

        const before = facts.locked();

        if (before.status === 'ARCHIVED') return;

        const changed = await this.projects.changeStatus(input.projectId, 'ARCHIVED');

        if (!changed) throw denyAccess('project', 'other_organization');

        await this.audit.record({
          action: 'project.archived',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: input.ipAddress,
          },
          target: { type: 'PROJECT', id: input.projectId },
          before: { status: before.status },
          after: { status: 'ARCHIVED' },
          requestId: undefined,
        });
      },
    );
  }
}
