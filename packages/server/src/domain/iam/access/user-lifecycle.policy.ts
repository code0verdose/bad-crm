import { type SharedPermissions } from '@bad-crm/shared';

import { type Actor } from '@/domain/access/actor.types.js';
import { accessErrorFor } from '@/domain/access/access.errors.js';
import { holdsEffectively } from '@/domain/access/authorize.util.js';
import { requireOwnershipTransferredBeforeOffboarding } from '@/domain/identity/access/owner-offboarding.policy.js';
import { ConflictError } from '@/domain/shared/errors/app.errors.js';

/**
 * What a subset check needs about the subject, on either side of the account's lifecycle.
 *
 * `permissions` is the subject's unexpired roles and ALLOW exceptions, in full — a subset check
 * cannot be made against a summary, and the whole point of the rule is the key that is *not* in the
 * actor's own set. `denied` is the subject's unexpired DENY exceptions, kept apart rather than
 * subtracted by the caller: a right the organization has already taken away from this person is not
 * one their offboarding — or their return — needs to be bounded by, and counting it would refuse the
 * operation on the strength of a permission nobody has.
 */
interface PermissionBoundSubject {
  readonly userId: string;
  readonly permissions: readonly SharedPermissions.PermissionKey[];
  readonly denied: readonly SharedPermissions.PermissionKey[];
}

/** Who is being deactivated, and what switching them off would reach past. */
export interface DeactivationSubject extends PermissionBoundSubject {
  /** `organizations.owner_id` of the tenant — the one account nobody can take rights from. */
  readonly organizationOwnerId: string;
}

/**
 * Who is being brought back, and what bringing them back would reach past.
 *
 * No `organizationOwnerId`: reactivating a former owner does not touch who owns the organization
 * now, so the owner-transfer conflict `assertDeactivable` guards has nothing to check here — see
 * `assertReactivable`.
 */
export type ReactivationSubject = PermissionBoundSubject;

/**
 * The three states offboarding must not be able to leave an organization in.
 *
 * The first two are **conflicts** rather than denials, and that is not a formality: the caller holds
 * `user:suspend` and the subject plainly exists, so neither `403` nor `404` describes what happened.
 * The request is refused because the system is in a state where it cannot be satisfied, and each
 * refusal names the step that changes that state.
 *
 * **Order matters, and it is not the order of severity.** Somebody deactivating their own account
 * while being the owner trips both of them; the self rule answers first because it is the one the
 * caller can act on. Telling an owner «transfer ownership first» when the real answer is «not to
 * yourself, ever» would send them to do a dangerous thing for no benefit. The owner rule in turn
 * comes before the subset rule below for the same kind of reason: the owner effectively holds every
 * key, so the subset rule would refuse them too — with advice that leads nowhere.
 *
 * The third is a denial, and it is the rule every other way of touching somebody's rights already
 * carries (`T-IAM-09`): **an account may only be switched off by somebody who holds everything it
 * holds.** `role-assignment.policy.ts`, `permission-override.policy.ts`, `role-composition.policy.ts`
 * and `invitation-access.policy.ts` all bound their operation this way, and offboarding reaches
 * further than any of them — it ends every session of the subject at once. Without the bound,
 * `user:suspend` alone is enough to walk the directory and switch off every other administrator and
 * manager in the organization, and only the owner can undo it: a lockout and a denial of service in
 * one call, held together by nothing but the goodwill of whoever holds one permission.
 *
 * The owner is exempt, exactly as in the other four: ownership short-circuits the capability layers,
 * so their actor carries an *empty* permission set rather than a complete one, and a naive check
 * would refuse the one account that holds everything.
 *
 * Pure, and deliberately ignorant of where any of this is stored. Neither conflict could live in the
 * database — «not yourself» is about the actor, whom the row knows nothing about, and the owner rule
 * spans two tables, where a soft delete never fires the foreign key that would otherwise catch it
 * (`owner-offboarding.policy.ts` explains that at length) — and the subset rule is a question about
 * two folded permission sets, which is not a shape SQL holds.
 */
export const assertDeactivable = (actor: Actor, subject: DeactivationSubject): void => {
  if (actor.userId === subject.userId) {
    throw new ConflictError('self_lockout', { cause: 'self_deactivation' });
  }

  requireOwnershipTransferredBeforeOffboarding(subject);

  const beyondActor = permissionsBeyond(actor, subject);

  if (beyondActor !== undefined) {
    // The key travels as developer context, not into the body: `details` never reaches the response
    // (see `AppError`), and naming the permission to the caller would tell somebody who may not
    // reach this account what that account can do.
    throw accessErrorFor('permission_not_granted', 'user', { permission: beyondActor });
  }
};

/**
 * The first permission the subject effectively holds and the actor does not — or `undefined`.
 *
 * «Effectively» on both sides, and it has to be: the subject's DENY exceptions are folded out here,
 * the actor's by `holdsEffectively`. Reading either raw set would break the rule in one of two
 * directions — refusing the operation over a right the subject was already denied, or letting an
 * administrator reach past an exception the organization wrote about them.
 *
 * Shared by `assertDeactivable` and `assertReactivable`: the rule is the same question — «does the
 * actor hold everything this subject holds» — on both sides of the account's lifecycle, and only the
 * conflicts around it (self-lockout, the owner transfer) differ between switching an account off and
 * bringing it back.
 */
const permissionsBeyond = (
  actor: Actor,
  subject: PermissionBoundSubject,
): SharedPermissions.PermissionKey | undefined => {
  if (actor.isOwner) return undefined;

  const deniedToSubject = new Set(subject.denied);

  return subject.permissions.find(
    (permission) => !deniedToSubject.has(permission) && !holdsEffectively(actor, permission),
  );
};

/**
 * The mirror of `assertDeactivable`'s subset rule, applied on the way back in.
 *
 * `user:reactivate` is checked by the route guard as a capability — «may this caller reactivate
 * anybody» — and that alone is not a bound on **which** account they may reactivate. Without this
 * rule, a single holder of `user:reactivate` could walk the directory and bring back every suspended
 * account, including one that outranks them and one that was suspended *because* it outranked
 * whoever suspended it — during an incident, an offboarding gone through under `assertDeactivable`'s
 * own subset rule is undone by a caller that rule would have refused. That is precisely the scenario
 * `packages/shared/src/audit/audit-severity.enums.ts` names `user.reactivated` `WARNING` for: «an
 * account coming back is the step an intruder needs after an offboarding.»
 *
 * **Deliberately narrower than `assertDeactivable`.** No self-lockout check: a suspended account
 * cannot authenticate, so nobody can be the actor of their own return — the case is unreachable, not
 * merely unchecked. No owner-transfer conflict either: reactivating a former owner does not change
 * `organizations.owner_id`, so there is nothing for that rule to guard here. The owner is exempt from
 * the subset rule itself for the same reason as in `assertDeactivable`: their actor carries an
 * *empty* permission set rather than a complete one.
 *
 * Reads the subject's permissions through the same port `assertDeactivable`'s caller does
 * (`EffectivePermissionsReaderPort`), and that has to work on a suspended account: the whole point of
 * the check is to bound a return *from* suspension by what the account could still do while
 * suspended, so the read cannot be gated on `status = 'ACTIVE'`.
 */
export const assertReactivable = (actor: Actor, subject: ReactivationSubject): void => {
  const beyondActor = permissionsBeyond(actor, subject);

  if (beyondActor !== undefined) {
    // Same code and reason `assertDeactivable` throws for the same rule (`user_forbidden` /
    // `permission_not_granted`), and the permission itself stays out of the response for the same
    // reason: it would tell somebody who may not reach this account what that account can do.
    throw accessErrorFor('permission_not_granted', 'user', { permission: beyondActor });
  }
};
