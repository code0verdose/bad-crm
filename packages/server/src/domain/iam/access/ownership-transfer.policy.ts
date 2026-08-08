import { type Actor } from '@/domain/access/actor.types.js';
import { type Decision } from '@/domain/access/decision.types.js';
import { assertAllowed, deny } from '@/domain/access/decision.util.js';
import { ConflictError } from '@/domain/shared/errors/app.errors.js';

/** The account the organization would be handed to, as the decision needs it. */
export interface TransferRecipient {
  readonly userId: string;
  readonly status: 'ACTIVE' | 'SUSPENDED' | 'INVITED';
}

/**
 * Whether this organization may change hands, and to this person.
 *
 * Three refusals, and they are deliberately different kinds. **Acting without being the owner** is
 * the caller holding a right that does not, on its own, make the row theirs to give away — `403`,
 * and the remedy is «ask the owner», not «fix your request». **Handing it to oneself** is a wrong
 * value in a field — `422`, and no state anywhere would make it right. **Handing it to a suspended
 * account** is a wrong state — `409`, with a next step: reactivate them, then transfer. Collapsing
 * any two of the three into one code would tell whoever reads the refusal to go and fix something
 * that is not what is actually broken.
 *
 * What is deliberately **not** here is the capability check. `organization:transfer_ownership` is
 * documented `owner`-only (`permission-model.md` §4.1) and the route guard answers whether the
 * caller *holds* it; a second evaluation of that in this file would be the second point of truth
 * `rules/permissions.mdc` forbids.
 *
 * **«Is the actor the owner» is checked here, and on purpose — this used to be the one thing this
 * function deliberately left out, on the reasoning that the permission already settles it.** It does
 * not. The capability layer folds roles, per-user ALLOW overrides and custom roles into one boolean,
 * and any of the three can hand `organization:transfer_ownership` to somebody who is not
 * `organizations.owner_id` — a genuine owner delegating "move it while I am on leave" is a supported
 * shape, not a misconfiguration. Skipping the check here does not remove a source of truth, it
 * removes the *only* one: without it, a delegate transfers ownership that is not theirs, and the
 * founder finds out on their next request when their own token has quietly become `admin`. Reading
 * `organizations.owner_id` is therefore not asking twice — the capability answers "may this caller
 * attempt a transfer", the row answers "whose organization is being given away", and only the second
 * question is what `assertTransferable` exists to settle.
 */
/** Kept beside the checks so the use-case names decisions rather than strings. */
const sameHolderRefused = (): Decision => deny('invalid_recipient');
const actingWithoutOwnership = (): Decision => deny('not_the_owner');

export const assertTransferable = (
  actor: Actor,
  currentOwnerId: string,
  recipient: TransferRecipient,
): void => {
  // First, and unconditionally: nothing below is worth deciding for somebody who is not
  // `organizations.owner_id`, and answering with the recipient's own refusal instead (a suspended
  // account, a self-transfer) would tell a delegate their request was *nearly* right.
  if (actor.userId !== currentOwnerId) assertAllowed(actingWithoutOwnership(), 'organization');

  if (actor.userId === recipient.userId) assertAllowed(sameHolderRefused(), 'user');

  if (recipient.status !== 'ACTIVE') {
    throw new ConflictError('recipient_not_active', { cause: recipient.status });
  }
};
