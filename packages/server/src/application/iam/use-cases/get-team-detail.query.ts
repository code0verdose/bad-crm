import {
  type TeamDetail,
  type TeamRepositoryPort,
} from '@/application/iam/ports/team-repository.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import { assertTeamAddressable, canReadTeams } from '@/domain/iam/access/team-access.policy.js';

export interface GetTeamDetailInput {
  readonly actor: Actor;
  readonly teamId: string;
}

/**
 * One team and who is on it.
 *
 * The capability is decided **before** the read, and that ordering is the point of writing it here
 * rather than leaning on the route guard alone: a caller who may not read teams is refused without a
 * statement being sent, so «you have no permission» and «that team does not exist» cost the same
 * (`docs/security/permission-model.md` §5). A team of another organization is invisible to the
 * tenant's policy, so the repository answers `null` and `teamAddressable` turns that into **404** —
 * never 403, which would make the API an oracle for ids in tenants the caller cannot see.
 *
 * The detail carries user ids and no names. Who these people are is `GET /employees` with
 * `user:read` behind it; answering it here would attach a second permission's worth of personal data
 * to a read that only asked about a team.
 */
export class GetTeamDetailQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly teams: TeamRepositoryPort,
  ) {}

  execute(input: GetTeamDetailInput): Promise<TeamDetail> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        assertAllowed(canReadTeams(input.actor), 'team');

        const team = await this.teams.detail(input.teamId);

        assertTeamAddressable(team);

        return team;
      },
    );
  }
}
