import { type TeamRepositoryPort } from '@/application/iam/ports/team-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import { assertTeamAddressable, canDeleteTeam } from '@/domain/iam/access/team-access.policy.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

export interface DeleteTeamInput {
  readonly actor: Actor;
  readonly teamId: string;
}

/**
 * Disbanding a team: the row is soft-deleted, every membership is removed outright.
 *
 * The two halves are deliberately different, and the asymmetry is the design. `teams.deleted_at` is
 * set because the name is referenced by things that outlive the team — the trail above all — and
 * because `uq_teams_org_slug` is partial, so hiding the row is what frees the slug for reuse.
 * `team_members` rows are **deleted**, because a membership is access rather than history: the same
 * reasoning offboarding applies when it takes somebody off every team (STORY-012-05), and a
 * membership pointing at a hidden team would be exactly the state a later `resolveAcl` would have to
 * remember to filter out.
 *
 * **The trail carries the roster, not a count, and `deactivate-user.use-case.ts` is why.** That
 * operation faces the identical fact — `team_members` has no `deleted_at`, so its own removal of
 * somebody's memberships is the last place `teamId`/`teamRole` survive — and answers it by writing
 * the list (`after.teams`, STORY-012-05). A count here would be the same fact given the opposite
 * answer for no reason the two use-cases disagree about.
 *
 * **The gap this closes is no longer "no ids anywhere" — the same gate fixed that half in
 * `accept-invitation.use-case.ts`, which now files `invitation.accepted` with `after.teamIds`
 * (STORY-012-07, M-2) instead of a count.** The roster still belongs on this entry, but the reason
 * is reconstruction cost, not reconstruction impossibility. `team.member_added` is never filed for a
 * membership an invitation created, so recovering who was on a disbanded team from the trail alone
 * would mean scanning every account's `invitation.accepted` (for the teams it joined this way) and
 * every `team.member_added`/`team.member_role_changed` (for the teams it joined or changed role in
 * through `POST /teams/{teamId}/members`) across the whole organization, correlating both by
 * `teamId`, and reducing each pair to whichever entry is most recent — and even then the role at
 * disbandment is not always recoverable: `InvitationRepositoryPort.joinTeams` writes no `team_role`
 * at all (every invitation-drafted membership starts `MEMBER` by column default), so a person
 * promoted to `LEAD` after joining this way is right only if their `team.member_role_changed` entry
 * is also found and correctly ordered against it. Nothing in this schema indexes the trail by team,
 * and no runbook performs that join. The entry below stays the one lookup that answers who was on
 * this team, and as what, the moment before it stopped existing.
 *
 * Every former member's permission version is bumped in the same transaction, in **one** statement.
 * Nothing they could do changes today — membership grants nothing until `ResourceAcl` exists
 * (STORY-011-06, blocked) — and the bump is still not decoration: `permissionsVersion` is the
 * mechanism by which a folded view stops being trusted, and a version that only started moving in
 * the release that made membership matter would leave every token minted before it trusting a
 * membership that had already been revoked.
 *
 * **What this deliberately does not do is cascade over `ResourceAcl`.** Acceptance 5 of the story
 * asks for it and there is nothing to cascade over: the table does not exist, and neither does
 * `resolveAcl`. A branch written for it now would be a refusal code nothing can reach, or a field
 * nobody can observe — an obligation with no test behind it. See the story file, «Расхождение с этой
 * спекой».
 */
export class DeleteTeamUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly teams: TeamRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: DeleteTeamInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        assertAllowed(canDeleteTeam(input.actor), 'team');

        const scope = await this.teams.scope(input.teamId);

        assertTeamAddressable(scope);

        const disbanded = await this.teams.disband(input.teamId);

        // Disbanded by somebody else between the decision and this write. The same answer as for a
        // team of another organization: from outside, both are «not there».
        if (disbanded === null) throw denyAccess('team', 'other_organization');

        // One statement for everybody, not a loop: fifty round trips inside a transaction with a
        // five-second ceiling is a save that fails on arithmetic rather than on anything being wrong.
        await this.teams.bumpPermissionsVersionOf(disbanded.members.map((member) => member.userId));

        await this.audit.record({
          action: 'team.deleted',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'TEAM', id: input.teamId },
          // The name and the full roster, each with the role they held: `team_members` has no
          // `deleted_at`, so after this transaction this entry is the only record the team had
          // anybody on it at all — and the only place `teamRole` survives, for whoever grants these
          // people access again once STORY-011-06 gives a team something to grant.
          before: {
            name: disbanded.name,
            members: disbanded.members.map((member) => ({
              userId: member.userId,
              teamRole: member.teamRole,
            })),
          },
          requestId: undefined,
        });
      },
    );
  }
}
