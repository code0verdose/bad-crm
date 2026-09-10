import { type AclScopeResolver } from '@/application/access/use-cases/resolve-acl.query.js';
import { type ProjectMemberRepositoryPort } from '@/application/project/ports/project-member-repository.port.js';
import { type ProjectRepositoryPort } from '@/application/project/ports/project-repository.port.js';
import { projectWriteFacts } from '@/application/project/project-write-facts.util.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import {
  canManageProjectMembers,
  canUpdateProject,
} from '@/domain/project/access/project-access.policy.js';
import {
  assertNotSelfJoin,
  assertProjectSubjectJoinable,
} from '@/domain/project/access/project-membership.policy.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

export interface UpdateProjectInput {
  readonly actor: Actor;
  readonly ipAddress: string | undefined;
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly leadId: string;
  readonly startedAt: Date | null;
  readonly dueAt: Date | null;
  readonly color: string;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * Editing a project — STORY-014-01, acceptance 3, 4, 5 and 6.
 *
 * **Replace, not merge**, for the reason the team edit gives: a partial body would make «clear the
 * description» unexpressible without a sentinel. `key` is not on the input at all — it is part of
 * every task number, and the update schema refuses it as an unknown field (acceptance 4).
 *
 * **Two decisions over one locked row.** `project:update` needs `EDITOR` and is decided first, before
 * a statement is sent. The lead is the one field that moves rights: the column is what the card
 * shows, but the `LEAD` **membership** is what grants `MANAGER`, and this command keeps the two in
 * step by writing (or promoting) that membership. An `EDITOR` who could do that through the rename
 * form would be handing `MANAGER` to anybody — so a changed `leadId` demands
 * `project:manage_members` on top, decided over the same facts without a second read
 * (`ProjectWriteFacts`). The membership entry it files is the one an escalation review reads;
 * `project.updated` itself stays `INFO`.
 *
 * The new lead is looked up as a subject exactly as `AddProjectMemberUseCase` looks one up: the
 * caller's own id is refused first (`self_assignment_forbidden` — nobody hands the lead to
 * themselves, whatever their grant), then 404 for another organization's account, 409 for a
 * suspended one (to a caller who may read the directory). A lead who already leads costs nothing —
 * no write, no entry, no bump.
 *
 * A row that vanished between the lock and the write cannot happen on a real database and is
 * answered here all the same: the 404 a foreign id gets, with no entry for a change that did not
 * happen.
 */
export class UpdateProjectUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly projects: ProjectRepositoryPort,
    private readonly members: ProjectMemberRepositoryPort,
    private readonly acl: AclScopeResolver,
    private readonly audit: AuditLoggerPort,
  ) {}

  execute(input: UpdateProjectInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const facts = projectWriteFacts(this.projects, this.acl, input.actor, input.projectId);

        assertAllowed(await canUpdateProject(input.actor, facts.read), 'project');

        const before = facts.locked();
        const leadChanged = input.leadId !== before.leadId;

        if (leadChanged) {
          assertAllowed(await canManageProjectMembers(input.actor, facts.read), 'project');
          // The same rule as on `POST …/members`, and the reason it is needed here too: a
          // `MANAGER` by an expiring grant who could name themselves lead would hold `MANAGER` by
          // membership after the grant is gone.
          assertNotSelfJoin(input.actor, input.leadId);
          assertProjectSubjectJoinable(input.actor, await this.members.subject(input.leadId));
        }

        const seat = leadChanged ? await this.seatTheLead(input.projectId, input.leadId) : null;

        const updated = await this.projects.update(input.projectId, {
          name: input.name,
          description: input.description,
          leadId: input.leadId,
          startedAt: input.startedAt,
          dueAt: input.dueAt,
          color: input.color,
        });

        if (!updated) throw denyAccess('project', 'other_organization');

        await this.audit.record({
          action: 'project.updated',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: input.ipAddress,
          },
          target: { type: 'PROJECT', id: input.projectId },
          before: {
            name: before.name,
            description: before.description,
            leadId: before.leadId,
            startedAt: iso(before.startedAt),
            dueAt: iso(before.dueAt),
            color: before.color,
          },
          after: {
            name: input.name,
            description: input.description,
            leadId: input.leadId,
            startedAt: iso(input.startedAt),
            dueAt: iso(input.dueAt),
            color: input.color,
          },
          requestId: undefined,
        });

        if (seat === null) return;

        await this.members.bumpPermissionsVersionOf([input.leadId]);

        if (seat.previousRole === null) {
          await this.audit.record({
            action: 'project.member_added',
            actor: {
              userId: input.actor.userId,
              organizationId: input.actor.organizationId,
              ipAddress: input.ipAddress,
            },
            target: { type: 'PROJECT', id: input.projectId },
            after: { userId: input.leadId, projectRole: 'LEAD', allocationPct: seat.allocationPct },
            requestId: undefined,
          });

          return;
        }

        await this.audit.record({
          action: 'project.member_role_changed',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: input.ipAddress,
          },
          target: { type: 'PROJECT', id: input.projectId },
          before: {
            userId: input.leadId,
            projectRole: seat.previousRole,
            allocationPct: seat.allocationPct,
          },
          after: { userId: input.leadId, projectRole: 'LEAD', allocationPct: seat.allocationPct },
          requestId: undefined,
        });
      },
    );
  }

  /**
   * The new lead's seat: written when they were not on the project, promoted when they were, left
   * alone when they already lead. `null` for the last case — nothing to bump, nothing to file.
   */
  private async seatTheLead(
    projectId: string,
    leadId: string,
  ): Promise<{ previousRole: string | null; allocationPct: number } | null> {
    const membership = await this.members.membershipOf(projectId, leadId);

    if (membership === null) {
      await this.members.add(projectId, leadId, 'LEAD', 100);

      return { previousRole: null, allocationPct: 100 };
    }

    if (membership.projectRole === 'LEAD') return null;

    await this.members.update(projectId, leadId, { projectRole: 'LEAD' });

    return { previousRole: membership.projectRole, allocationPct: membership.allocationPct };
  }
}
