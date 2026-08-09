import {
  type TeamListEntry,
  type TeamRepositoryPort,
} from '@/application/iam/ports/team-repository.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';

export interface ListTeamsInput {
  readonly actor: Actor;
}

/**
 * Every live team of the organization, with how many people are on each.
 *
 * **Filtered in SQL, not afterwards** (`rules/permissions.mdc`, 8): the deleted rows never leave the
 * database, so the count the screen renders and the rows it renders are one query and cannot
 * disagree. There is no per-row access decision to make — `team:read` carries no `requiredLevel`,
 * and the answer is the whole tenant, which the row-level-security policy already bounds.
 *
 * No `team:read` check in this body: the guard on the route made it, and a second evaluation of the
 * same capability is the second point of truth `rules/permissions.mdc`, 10 forbids. What a use-case
 * owes is the decision the guard cannot make, and for a list scoped to the tenant there is none.
 */
export class ListTeamsQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly teams: TeamRepositoryPort,
  ) {}

  execute(input: ListTeamsInput): Promise<readonly TeamListEntry[]> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      () => this.teams.list(),
    );
  }
}
