import {
  type CustomRoleRepositoryPort,
  type RoleListEntry,
} from '@/application/iam/ports/role-repository.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';

export interface ListRolesInput {
  readonly actor: Actor;
}

/**
 * Every role of the organization, with what it grants and how many people hold it.
 *
 * One read rather than a list endpoint plus a detail endpoint per row: what this answers is the
 * administration matrix — every role beside every permission — and a screen that has to ask again
 * for each row shows the first role before it knows the second exists.
 *
 * **System roles are in the answer.** They cannot be edited here, but leaving them out would mean
 * the screen showing a matrix that omits the roles most people actually hold, and the client already
 * has `isSystem` to render the difference.
 *
 * No `role:read` check in this body: the guard on the route did it, and a second evaluation of the
 * same capability is the second point of truth `rules/permissions.mdc` forbids. What a use-case owes
 * is the decision the guard **cannot** make — here there is none, because the answer is the whole
 * tenant and the tenant is the scope.
 */
export class ListRolesQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly roles: CustomRoleRepositoryPort,
  ) {}

  execute(input: ListRolesInput): Promise<readonly RoleListEntry[]> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      () => this.roles.list(),
    );
  }
}
