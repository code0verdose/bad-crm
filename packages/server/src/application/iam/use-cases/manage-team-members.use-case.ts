import { type TeamRepositoryPort } from '@/application/iam/ports/team-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import {
  assertMemberJoinable,
  assertTeamAddressable,
  canManageTeamMembers,
} from '@/domain/iam/access/team-access.policy.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

export interface AddTeamMemberInput {
  readonly actor: Actor;
  readonly teamId: string;
  readonly userId: string;
  /** `MEMBER` | `LEAD`, as `ck_team_members_role` constrains it. */
  readonly teamRole: string;
}

export interface RemoveTeamMemberInput {
  readonly actor: Actor;
  readonly teamId: string;
  readonly userId: string;
}

/**
 * Putting somebody on a team — or, on a repeat call with a different `teamRole`, changing the one
 * they hold.
 *
 * **The lead is a membership, not a column.** `Team` has no `lead_id`: the role is
 * `team_members.team_role = 'LEAD'`, constrained by `ck_team_members_role`. Two models of the same
 * fact would drift the first time one of them was written without the other — see the story file,
 * «Расхождение с этой спекой», for why the spec's `leadId` was not added. There being no separate
 * endpoint for a role change is the direct consequence: this one is it (the gate's L-3).
 *
 * Three refusals, in this order and for three different reasons. The **capability** first, before
 * any statement is sent, so the caller who may not manage members cannot time the difference between
 * that and a team that does not exist. Then the **team**: a foreign or disbanded id is `404`, never
 * 403 (invariant 2). Then the **subject**: a suspended account is a `409` with a next step, because
 * offboarding takes people off teams precisely so that a deactivated person is on none — and that
 * 409 is itself gated on the caller holding `user:read`, so somebody who may manage a roster but may
 * not read the directory cannot use this endpoint to learn *which* inactive state an account is in
 * (the gate's L-1; `assertMemberJoinable`, `team-access.policy.ts`).
 *
 * The write is idempotent by constraint — `uq_team_members (team_id, user_id)` — for a repeated call
 * with the *same* role: no second write, no second trail entry, no bump. A repeat with a *different*
 * role is no longer idempotent by design, and the repository reports the three-way outcome the audit
 * below needs to tell a new membership from a change to an old one.
 */
export class AddTeamMemberUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly teams: TeamRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: AddTeamMemberInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        assertAllowed(canManageTeamMembers(input.actor), 'team');

        const scope = await this.teams.scope(input.teamId);

        assertTeamAddressable(scope);
        assertMemberJoinable(input.actor, await this.teams.subject(input.userId));

        const result = await this.teams.addMember(input.teamId, input.userId, input.teamRole);

        if (result.outcome === 'unchanged') return;

        await this.teams.bumpPermissionsVersionOf([input.userId]);

        const actor = {
          userId: input.actor.userId,
          organizationId: input.actor.organizationId,
          ipAddress: undefined,
        };
        // Filed against the team rather than the person in both branches: «what happened to this
        // team» is the question a membership change answers, and the person is in the payload.
        const target = { type: 'TEAM', id: input.teamId } as const;

        if (result.outcome === 'created') {
          await this.audit.record({
            action: 'team.member_added',
            actor,
            target,
            after: { userId: input.userId, teamRole: input.teamRole },
            requestId: undefined,
          });

          return;
        }

        await this.audit.record({
          action: 'team.member_role_changed',
          actor,
          target,
          before: { userId: input.userId, teamRole: result.previousRole },
          after: { userId: input.userId, teamRole: input.teamRole },
          requestId: undefined,
        });
      },
    );
  }
}

/**
 * Taking somebody off a team.
 *
 * The row is deleted rather than flagged, for the reason `team_members` has no `deleted_at` at all:
 * a membership that ended is not a membership with a flag, and a filter everybody has to remember is
 * a filter somebody forgets.
 *
 * A membership that was not there is `404` — the same answer as a team that is not there. It is the
 * honest one: the caller asked to remove something the organization does not have, and reporting
 * success would tell them a state was reached that never existed.
 */
export class RemoveTeamMemberUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly teams: TeamRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: RemoveTeamMemberInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        assertAllowed(canManageTeamMembers(input.actor), 'team');

        const scope = await this.teams.scope(input.teamId);

        assertTeamAddressable(scope);

        const removed = await this.teams.removeMember(input.teamId, input.userId);

        if (!removed) throw denyAccess('user', 'other_organization');

        await this.teams.bumpPermissionsVersionOf([input.userId]);

        await this.audit.record({
          action: 'team.member_removed',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'TEAM', id: input.teamId },
          before: { userId: input.userId },
          requestId: undefined,
        });
      },
    );
  }
}
