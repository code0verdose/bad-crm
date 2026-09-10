import { type AclScopeResolver } from '@/application/access/use-cases/resolve-acl.query.js';
import {
  type ProjectMemberEntry,
  type ProjectMemberRepositoryPort,
} from '@/application/project/ports/project-member-repository.port.js';
import { type ProjectRepositoryPort } from '@/application/project/ports/project-repository.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import {
  canReadProject,
  type ProjectAccessFacts,
} from '@/domain/project/access/project-access.policy.js';

export interface ListProjectMembersInput {
  readonly actor: Actor;
  readonly projectId: string;
  /** The people who left, too — shown only on request (STORY-014-02, acceptance 10). */
  readonly includeLeft: boolean;
}

/**
 * The roster of one project — STORY-014-02, acceptance 10, the server half.
 *
 * Gated exactly as the card is: `project:read`, `VIEWER` on the chain, decided over `scope()` under
 * `FOR SHARE` before the roster is read — so a `PRIVATE` project's roster is the same 404 to an
 * outsider as the project itself, and a caller without the key is refused before a statement is
 * sent. User ids and no names, as the team roster: who these people are is the directory, behind
 * its own permission.
 */
export class ListProjectMembersQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly projects: ProjectRepositoryPort,
    private readonly members: ProjectMemberRepositoryPort,
    private readonly acl: AclScopeResolver,
  ) {}

  execute(input: ListProjectMembersInput): Promise<readonly ProjectMemberEntry[]> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        assertAllowed(
          await canReadProject(input.actor, () => this.facts(input.actor, input.projectId)),
          'project',
        );

        return this.members.roster(input.projectId, { includeLeft: input.includeLeft });
      },
    );
  }

  private async facts(actor: Actor, projectId: string): Promise<ProjectAccessFacts> {
    return {
      scope: await this.projects.scope(projectId),
      acl: await this.acl.resolve(actor, { type: 'PROJECT', id: projectId }),
    };
  }
}
