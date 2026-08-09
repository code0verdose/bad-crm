import { type TeamRepositoryPort } from '@/application/iam/ports/team-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import {
  assertTeamAddressable,
  canCreateTeam,
  canUpdateTeam,
} from '@/domain/iam/access/team-access.policy.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

export interface CreateTeamInput {
  readonly actor: Actor;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
}

export interface UpdateTeamInput extends CreateTeamInput {
  readonly teamId: string;
}

/** The team as it was stored — what the caller gets back instead of having to read it again. */
export interface CreatedTeam {
  readonly teamId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
}

/**
 * Creating a team.
 *
 * **Nobody's access changes.** A `Team` is an org-structure container: no permission is derived from
 * membership, and the `ResourceAcl` that would make a team the subject of a grant is STORY-011-06,
 * blocked until a resource layer exists. So there is no permission version to bump here and no
 * escalation rule to apply — the two things that make the equivalent role use-case as long as it is.
 *
 * The slug is unique inside the organization and nowhere else. `uq_teams_org_slug` is **partial**
 * (`WHERE deleted_at IS NULL`), which is what makes a slug freed by disbanding a team reusable — and
 * it is the only check: a pre-flight `SELECT` would be a read that a concurrent insert invalidates
 * between the two statements, so the constraint is left to answer, translated to `409
 * team_already_exists` by `TenantScopedRepository`.
 */
export class CreateTeamUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly teams: TeamRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: CreateTeamInput): Promise<CreatedTeam> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        assertAllowed(canCreateTeam(input.actor), 'team');

        const teamId = await this.teams.create({
          name: input.name,
          slug: input.slug,
          description: input.description,
        });

        await this.audit.record({
          action: 'team.created',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'TEAM', id: teamId },
          after: { name: input.name, slug: input.slug },
          requestId: undefined,
        });

        return {
          teamId,
          name: input.name,
          slug: input.slug,
          description: input.description,
        };
      },
    );
  }
}

/**
 * Renaming a team, or moving its slug.
 *
 * **Replace, not merge**: the body is what the team will be. A PATCH that merged would make «clear
 * the description» unexpressible without a sentinel value, and the field is optional prose rather
 * than something a client can be expected to round-trip correctly.
 *
 * The capability is decided before the row is read, so a caller who may not edit teams is refused
 * without a statement being sent and cannot time the difference between «no permission» and «no such
 * team». A team of another organization — or one already disbanded — is `404`, never 403.
 *
 * No permission version is bumped, and that is not an omission: renaming a container moves nobody
 * between containers. The bump belongs to membership, which this operation does not touch.
 */
export class UpdateTeamUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly teams: TeamRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: UpdateTeamInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        assertAllowed(canUpdateTeam(input.actor), 'team');

        // `summary`, not `detail`: the audit `before` below reads only `name`/`slug`, and `detail`
        // would pull the whole roster along for nothing on every rename.
        const before = await this.teams.summary(input.teamId);

        assertTeamAddressable(before);

        const updated = await this.teams.update(input.teamId, {
          name: input.name,
          slug: input.slug,
          description: input.description,
        });

        // Disbanded between the read above and this write: the same answer as for a team of another
        // organization, because from outside the two are indistinguishable and both are «not there».
        if (!updated) throw denyAccess('team', 'other_organization');

        await this.audit.record({
          action: 'team.updated',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'TEAM', id: input.teamId },
          // Both sides carry the name and the slug: «became X» recorded alone leaves «from what?»
          // unanswerable without replaying the history.
          before: { name: before.name, slug: before.slug },
          after: { name: input.name, slug: input.slug },
          requestId: undefined,
        });
      },
    );
  }
}
