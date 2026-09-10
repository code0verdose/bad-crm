import { type AclScopeResolver } from '@/application/access/use-cases/resolve-acl.query.js';
import { type ProjectMemberRepositoryPort } from '@/application/project/ports/project-member-repository.port.js';
import { type ProjectRepositoryPort } from '@/application/project/ports/project-repository.port.js';
import { projectWriteFacts } from '@/application/project/project-write-facts.util.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import { canManageProjectMembers } from '@/domain/project/access/project-access.policy.js';
import {
  assertLastLeadKept,
  assertNotSelfJoin,
  assertProjectSubjectJoinable,
} from '@/domain/project/access/project-membership.policy.js';
import { type ProjectMembership } from '@/domain/project/project.entity.js';
import { type ProjectRole } from '@/domain/project/project.enums.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

interface ProjectMemberCommand {
  readonly actor: Actor;
  readonly ipAddress: string | undefined;
  readonly projectId: string;
  readonly userId: string;
}

export interface AddProjectMemberInput extends ProjectMemberCommand {
  readonly projectRole: ProjectRole;
  readonly allocationPct: number;
}

export interface UpdateProjectMemberInput extends ProjectMemberCommand {
  readonly projectRole?: ProjectRole;
  readonly allocationPct?: number;
}

export type RemoveProjectMemberInput = ProjectMemberCommand;

/** What the three commands share: the decision over the locked row, and the trail's actor. */
abstract class ProjectMemberUseCase {
  constructor(
    protected readonly unitOfWork: UnitOfWorkPort,
    protected readonly projects: ProjectRepositoryPort,
    protected readonly members: ProjectMemberRepositoryPort,
    protected readonly acl: AclScopeResolver,
    protected readonly audit: AuditLoggerPort,
  ) {}

  /**
   * `project:manage_members`, `MANAGER`, over the row under `FOR UPDATE` — so that two commands on
   * one roster run one after the other, and «the last lead» is counted against a roster nobody is
   * changing at the same time. The lock is the project's; `leads()` adds its own on the rows.
   */
  protected async authorize(input: ProjectMemberCommand): Promise<void> {
    const facts = projectWriteFacts(this.projects, this.acl, input.actor, input.projectId);

    assertAllowed(await canManageProjectMembers(input.actor, facts.read), 'project');
    facts.locked();
  }

  /** A role change, filed with both sides and the person's folded view invalidated. */
  protected async fileRoleChange(
    input: ProjectMemberCommand,
    before: ProjectMembership,
    after: ProjectMembership,
  ): Promise<void> {
    await this.members.bumpPermissionsVersionOf([input.userId]);

    await this.audit.record({
      action: 'project.member_role_changed',
      actor: {
        userId: input.actor.userId,
        organizationId: input.actor.organizationId,
        ipAddress: input.ipAddress,
      },
      target: { type: 'PROJECT', id: input.projectId },
      before: {
        userId: input.userId,
        projectRole: before.projectRole,
        allocationPct: before.allocationPct,
      },
      after: {
        userId: input.userId,
        projectRole: after.projectRole,
        allocationPct: after.allocationPct,
      },
      requestId: undefined,
    });
  }
}

/**
 * Putting somebody on a project — STORY-014-02, acceptance 1, 6 and 8; and, on a repeat for a
 * person already on it, the same reading the team roster settled on (its gate's L-3): a different
 * role is a role change and is filed as one, a different allocation alone is applied quietly, the
 * same seat is a silent no-op. A client is never told 204 for a state it did not reach.
 *
 * Four refusals, in this order and for four reasons. The **capability and the level** first, before
 * any statement is sent (403 inside the contour, 404 outside it). Then **the caller's own id**: the
 * right to manage a roster is the right over other people, and «добавил себя, прочитал, удалил» is
 * the attack `T-PROJ-02` names (`assertNotSelfJoin`). Then **the subject**: another organization's
 * account is 404, a suspended one 409 — the latter only to a caller who also holds `user:read`
 * (`assertProjectSubjectJoinable`). Then, on a repeat that would demote the only lead, **the last
 * lead stays**.
 *
 * The membership is read before the insert rather than inferred from its outcome, and the project
 * lock is what makes that read safe: every roster command holds the row `FOR UPDATE`, so nothing
 * changes the roster between the read and the write. An insert the database still refused — a
 * row written past the lock, by a raw statement — is treated as the seat already held.
 */
export class AddProjectMemberUseCase extends ProjectMemberUseCase {
  execute(input: AddProjectMemberInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        await this.authorize(input);

        assertNotSelfJoin(input.actor, input.userId);
        assertProjectSubjectJoinable(input.actor, await this.members.subject(input.userId));

        const existing = await this.members.membershipOf(input.projectId, input.userId);

        if (existing !== null) {
          await this.repeat(input, existing);

          return;
        }

        const added = await this.members.add(
          input.projectId,
          input.userId,
          input.projectRole,
          input.allocationPct,
        );

        if (!added) return;

        await this.members.bumpPermissionsVersionOf([input.userId]);

        await this.audit.record({
          action: 'project.member_added',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: input.ipAddress,
          },
          target: { type: 'PROJECT', id: input.projectId },
          after: {
            userId: input.userId,
            projectRole: input.projectRole,
            allocationPct: input.allocationPct,
          },
          requestId: undefined,
        });
      },
    );
  }

  /** A repeat for somebody already on the project: a role change, an allocation, or nothing. */
  private async repeat(input: AddProjectMemberInput, existing: ProjectMembership): Promise<void> {
    const roleChanged = existing.projectRole !== input.projectRole;
    const allocationChanged = existing.allocationPct !== input.allocationPct;

    if (!roleChanged && !allocationChanged) return;

    if (roleChanged && existing.projectRole === 'LEAD') {
      assertLastLeadKept(await this.members.leads(input.projectId), input.userId);
    }

    await this.members.update(input.projectId, input.userId, {
      projectRole: input.projectRole,
      allocationPct: input.allocationPct,
    });

    if (!roleChanged) return;

    await this.fileRoleChange(input, existing, {
      projectRole: input.projectRole,
      allocationPct: input.allocationPct,
    });
  }
}

/**
 * Changing a membership — STORY-014-02, acceptance 4 and 7.
 *
 * A field that is absent is left as it is. A role that moves is a change of rights: bumped and
 * filed — and refused for the caller's own seat, for the reason `POST` refuses a self-join (a
 * `MANAGER` by an expiring grant must not be able to make that level permanent by promoting
 * themselves). An allocation that moves alone grants nothing and takes nothing — applied, and
 * neither bumped nor filed, one's own included. Demoting the only lead is refused before the
 * write.
 *
 * Somebody who is not on the project is `404 user_not_found`, the answer the team roster gives for
 * the identical fact: the caller asked to change something the organization does not have.
 */
export class UpdateProjectMemberUseCase extends ProjectMemberUseCase {
  execute(input: UpdateProjectMemberInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        await this.authorize(input);

        const existing = await this.members.membershipOf(input.projectId, input.userId);

        if (existing === null) throw denyAccess('user', 'other_organization');

        const after: ProjectMembership = {
          projectRole: input.projectRole ?? existing.projectRole,
          allocationPct: input.allocationPct ?? existing.allocationPct,
        };
        const roleChanged = after.projectRole !== existing.projectRole;

        if (!roleChanged && after.allocationPct === existing.allocationPct) return;

        // One's own role is not one's to change, in either direction — the rule `POST` applies to
        // a seat, applied to a seat's level. One's own allocation is: it moves no rights.
        if (roleChanged) assertNotSelfJoin(input.actor, input.userId);

        if (roleChanged && existing.projectRole === 'LEAD') {
          assertLastLeadKept(await this.members.leads(input.projectId), input.userId);
        }

        const updated = await this.members.update(input.projectId, input.userId, after);

        if (!updated) throw denyAccess('user', 'other_organization');

        if (roleChanged) await this.fileRoleChange(input, existing, after);
      },
    );
  }
}

/**
 * Taking somebody off a project — STORY-014-02, acceptance 5 and 7.
 *
 * The row is kept and `left_at` stamped: the membership is history and a link target, and the
 * partial unique index is what lets the same person come back later as a new row. The folded view
 * is invalidated in the same scope, so the access is gone on the next request. The only lead does
 * not leave.
 */
export class RemoveProjectMemberUseCase extends ProjectMemberUseCase {
  execute(input: RemoveProjectMemberInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        await this.authorize(input);

        const existing = await this.members.membershipOf(input.projectId, input.userId);

        if (existing === null) throw denyAccess('user', 'other_organization');

        if (existing.projectRole === 'LEAD') {
          assertLastLeadKept(await this.members.leads(input.projectId), input.userId);
        }

        const left = await this.members.leave(input.projectId, input.userId);

        if (!left) throw denyAccess('user', 'other_organization');

        await this.members.bumpPermissionsVersionOf([input.userId]);

        await this.audit.record({
          action: 'project.member_removed',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: input.ipAddress,
          },
          target: { type: 'PROJECT', id: input.projectId },
          before: {
            userId: input.userId,
            projectRole: existing.projectRole,
            allocationPct: existing.allocationPct,
          },
          requestId: undefined,
        });
      },
    );
  }
}
