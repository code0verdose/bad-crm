import { type AclScopeResolver } from '@/application/access/use-cases/resolve-acl.query.js';
import { type ProjectMemberRepositoryPort } from '@/application/project/ports/project-member-repository.port.js';
import { type ProjectRepositoryPort } from '@/application/project/ports/project-repository.port.js';
import { type ProjectCard, projectReadFacts } from '@/application/project/project-card.util.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import {
  assertProjectAddressable,
  canCreateProject,
  type ProjectAccessFacts,
} from '@/domain/project/access/project-access.policy.js';
import { assertProjectSubjectJoinable } from '@/domain/project/access/project-membership.policy.js';
import { decideProjectPermissions } from '@/domain/project/access/project-permissions.policy.js';
import { type ProjectVisibility } from '@/domain/project/project.enums.js';

export interface CreateProjectInput {
  readonly actor: Actor;
  /** The caller's address, for the trail — the same field every project command carries. */
  readonly ipAddress: string | undefined;
  /** Already normalized by the value object at the boundary: `BAD`, never `" bad "`. */
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly visibility: ProjectVisibility;
  readonly leadId: string;
  readonly startedAt: Date | null;
  readonly dueAt: Date | null;
  readonly color: string;
}

/**
 * The facts handed to a decision that has no row to decide on.
 *
 * `project:create` carries no level, so `authorizeWith` never invokes this — the table test holds
 * that. It is fail-closed on purpose: should the catalogue ever give creation a level, the decision
 * would read `missing` and refuse loudly, rather than pass on a fact nobody wrote.
 */
const NO_PROJECT_YET = (): Promise<ProjectAccessFacts> =>
  Promise.resolve({ scope: null, acl: { status: 'missing' } });

/**
 * Creating a project — STORY-014-01, acceptance 1 and 2.
 *
 * **The creator and the lead are the first two `LEAD` memberships**, written in the transaction
 * that writes the row: a project nobody leads has nobody holding `MANAGER` on it by membership, and
 * the person who just created it would be an `EDITOR` of their own project on a `PUBLIC_ORG`
 * fixture and nobody at all on a `PRIVATE` one. Both folded views are invalidated — the creator's
 * too, so the very next request already reads the new seat.
 *
 * **The lead is looked up before anything is written.** A lead of another organization is nobody
 * (404, the composite key would have refused the row anyway, but a 500 is not the answer); a
 * suspended one is a 409 with a next step — the same rule the roster applies
 * (`assertProjectSubjectJoinable`), so that the two paths onto a project cannot disagree about who
 * may be on one. The story's `422 invalid_lead` was not added as a code: the two states it named are
 * already `user_not_found` and `member_not_active`, and a third code for the same two facts would
 * be a third sentence for the client to translate.
 *
 * **The key is unique among live projects of the organization and nowhere else**, and the partial
 * index is the only check: a pre-flight `SELECT` is a read a concurrent insert invalidates between
 * the two statements, so the constraint answers, translated to `409 project_already_exists` by
 * `TenantScopedRepository`. The story's `project_key_taken` is that code.
 *
 * One trail entry rather than one plus a seat entry per membership: the two seats are the project's
 * initial state, not somebody being put on an existing project, and `after.members` carries them
 * (`audit-action.enums.ts`, `project.created`).
 */
export class CreateProjectUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly projects: ProjectRepositoryPort,
    private readonly members: ProjectMemberRepositoryPort,
    private readonly acl: AclScopeResolver,
    private readonly audit: AuditLoggerPort,
  ) {}

  execute(input: CreateProjectInput): Promise<ProjectCard> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        assertAllowed(await canCreateProject(input.actor, NO_PROJECT_YET), 'project');

        assertProjectSubjectJoinable(input.actor, await this.members.subject(input.leadId));

        const projectId = await this.projects.create({
          key: input.key,
          name: input.name,
          description: input.description,
          visibility: input.visibility,
          leadId: input.leadId,
          startedAt: input.startedAt,
          dueAt: input.dueAt,
          color: input.color,
        });

        const seats = [...new Set([input.actor.userId, input.leadId])];

        for (const userId of seats) await this.members.add(projectId, userId, 'LEAD', 100);

        await this.members.bumpPermissionsVersionOf(seats);

        await this.audit.record({
          action: 'project.created',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: input.ipAddress,
          },
          target: { type: 'PROJECT', id: projectId },
          after: {
            key: input.key,
            name: input.name,
            visibility: input.visibility,
            leadId: input.leadId,
            members: seats.map((userId) => ({ userId, projectRole: 'LEAD' })),
          },
          requestId: undefined,
        });

        const detail = await this.projects.detail(projectId);

        // Unreachable on a real database — the row was written in this transaction — and still the
        // same 404 rather than a `null` the compiler would let through.
        assertProjectAddressable(detail);

        // The response is the card's `ProjectDetail`, so it carries the card's block, decided the
        // card's way — over the row and the chain as this transaction now sees them, seats included.
        const permissions = await decideProjectPermissions(
          input.actor,
          projectReadFacts(this.projects, this.acl, input.actor, projectId),
        );

        return { ...detail, permissions };
      },
    );
  }
}
