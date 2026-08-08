import {
  type InvitationRepositoryPort,
  type InvitationRow,
} from '@/application/iam/ports/invitation-repository.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';

export interface ListInvitationsInput {
  readonly actor: Actor;
}

/**
 * The invitations still waiting to be accepted, newest first.
 *
 * **Open ones only.** An accepted invitation is a person, and a person belongs to the directory
 * (STORY-012-04) — listing them here would be the same human shown twice, in two states, on two
 * screens that disagree about what they are.
 *
 * No expiry filter either: an expired invitation is still on this list, because it is exactly the
 * row somebody wants to resend or revoke, and hiding it would leave it addressable by id and
 * invisible on the screen that addresses it. Whether the link still works is the token check's
 * business, not this list's.
 *
 * No capability check in this body: the guard on the route did it, and a second evaluation of the
 * same capability is the second point of truth `rules/permissions.mdc` forbids. What a use-case owes
 * is the decision the guard cannot make — here there is none, because the answer is the whole tenant
 * and the tenant is the scope.
 */
export class ListInvitationsQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly invitations: InvitationRepositoryPort,
  ) {}

  execute(input: ListInvitationsInput): Promise<readonly InvitationRow[]> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      () => this.invitations.listOpen(),
    );
  }
}
