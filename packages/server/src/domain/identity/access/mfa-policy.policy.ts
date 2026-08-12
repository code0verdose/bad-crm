import { type SharedPermissions } from '@bad-crm/shared';

import { accessErrorFor } from '@/domain/access/access.errors.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { holdsEffectively } from '@/domain/access/authorize.util.js';
import { ConflictError } from '@/domain/shared/errors/app.errors.js';

/**
 * The self-reset refusal: an administrator may not reset their own second factor through this path.
 *
 * `assertMfaResetInBounds` below is the second of the two refusals `ResetUserMfaUseCase` needs from
 * `domain` — this one is checked first and separately, before the subject is even looked up (see the
 * use-case's own docstring for why that ordering is safe to keep).
 *
 * **Why this is a conflict, not a denial.** `user:reset_mfa` is checked by the route guard as a
 * capability — "may this caller reset anybody's 2FA" — and the caller genuinely holds it; the
 * subject genuinely exists. Neither `403` nor `404` describes what is wrong, on the identical
 * reasoning `assertDeactivable` gives for `self_lockout` in `user-lifecycle.policy.ts`: the request
 * cannot be satisfied in the current shape because of *who it names*, and the one thing that would
 * make it satisfiable — targeting somebody else — is a fact about the request, not a right the actor
 * is missing.
 *
 * **Why it exists at all.** `ResetUserMfaUseCase` skips the password and TOTP-or-recovery-code
 * checks `DisableTotpUseCase` requires (STORY-013-04, acceptance 1 and 2) — that is the entire point
 * of an administrative reset, a way back in for somebody who has neither. Aimed at the actor's own
 * account, the same request becomes a way to strip a second factor from a session that holds it
 * without proving anything beyond the session itself: exactly the bypass STORY-013-04's acceptance 3
 * refuses on the self-service path (`T-IAM-01`, "a session is not the second factor"), reached
 * through the one door that path does not guard.
 *
 * Pure, like every file in this directory (`rules/hexagonal-backend.mdc`): no I/O, no `Date.now()`,
 * nothing the caller could not have computed from the two ids already in hand.
 *
 * **What this file does not contain.** STORY-013-04's task list also names
 * `assertNotRequiredByPolicy` — refusing a *self-service* disable while an organization's mandatory-
 * 2FA policy still applies to the caller's role. That policy does not exist yet: it is
 * [STORY-013-05](../../../../../epics/epic-013-two-factor-totp/stories/story-013-05-org-2fa-policy.md),
 * still `backlog`. A function with nothing to read — no policy row, no per-role flag — would either
 * always allow (dead code, `rules/commit-hygiene.mdc`, rule 1) or hard-code a refusal nothing in this
 * delta can turn off, and this codebase has already paid for that mistake twice: a `deny` reason
 * published in the error catalogue, translated into both locales and thrown by nothing
 * (`docs/brain/` records both). It is not written here; STORY-013-05 adds it beside the policy row it
 * reads.
 */
export const assertNotSelfReset = (actor: Actor, subjectUserId: string): void => {
  if (actor.userId === subjectUserId) {
    throw new ConflictError('self_lockout', { cause: 'self_mfa_reset' });
  }
};

/**
 * What the rank rule needs about the account whose second factor is about to be stripped, read
 * through the same port every other subset rule reads (`EffectivePermissionsReaderPort`), inside the
 * transaction `ResetUserMfaUseCase` already opened for the write — the identical shape and the
 * identical reason `DeactivateUserUseCase` reads its own subject's facts there rather than trusting a
 * snapshot taken before the transaction: a role granted mid-request must not slip past the bound.
 *
 * `permissions` and `denied` are `CapabilityFacts.granted`/`.denied` verbatim — the subject's full,
 * unexpired roles-plus-ALLOW-overrides set and DENY set, not a summary. A subset check cannot be made
 * against a summary; the whole point of the rule is the one key that is *not* in the actor's own set.
 */
export interface MfaResetSubject {
  readonly userId: string;
  /** `organizations.owner_id === userId`, from `CapabilityFacts.isOwner`. */
  readonly isOwner: boolean;
  readonly permissions: readonly SharedPermissions.PermissionKey[];
  readonly denied: readonly SharedPermissions.PermissionKey[];
}

/**
 * The bound `assertNotSelfReset` alone does not give: an administrative reset may not reach further
 * than the actor's own standing.
 *
 * ## Why this exists
 *
 * `ResetUserMfaUseCase` is a way back in that skips every proof `DisableTotpUseCase` requires — no
 * password, no live code, no recovery code (STORY-013-04, acceptance 5's whole reason to exist).
 * Guarded only by `assertNotSelfReset`, `user:reset_mfa` — held by both `owner` and `admin`
 * (`permission-model.md` §4) — lets one administrator strip the organization owner's second factor:
 * secret cleared, recovery codes gone, sessions revoked, the account still `ACTIVE` and now protected
 * by nothing the owner did not choose beyond a password. From there the owner's password is the only
 * thing standing between that administrator and the organization, and the same request reaches any
 * other administrator or a custom role holding the same permission — sideways, not only upward.
 *
 * This is precisely `T-IAM-09`, the rank rule every other way of touching somebody's rights already
 * carries: `role-assignment.policy.ts`, `permission-override.policy.ts`, `role-composition.policy.ts`,
 * `invitation-access.policy.ts` and both directions of `user-lifecycle.policy.ts` all bound their
 * operation this way. `ResetUserMfaUseCase` was the one path without it — an administrator who cannot
 * take the owner's roles away, grant themselves a permission, or even offboard the owner without a
 * transfer first (`owner-offboarding.policy.ts`, `last_owner_required`) could nonetheless strip that
 * same owner's second factor with nothing but `user:reset_mfa`.
 *
 * ## Two refusals, and the order is not arbitrary
 *
 * **The owner is checked first, by name, before the subset rule below.** The owner holds every key by
 * construction (`SYSTEM_ROLE_PERMISSIONS.owner`), so the subset rule would refuse a non-owner actor
 * anyway in the overwhelming majority of cases — but a subset check is a comparison over whatever the
 * actor happens to hold, and a custom role or a generous stack of per-user ALLOW overrides could in
 * principle cover every key without making the holder the owner. Stating the owner rule by name closes
 * that gap outright rather than leaving the organization's one unremovable account protected by
 * however completely somebody else's grants happen to add up — the identical reasoning
 * `canWriteOverride`'s `owner_immutable` gives for refusing a DENY on the owner "twice on purpose": a
 * rule this load-bearing does not get to depend on an emergent property of an unrelated table staying
 * true. Checking it first also gives the right refusal: `not_the_owner`, not `permission_not_granted`
 * — the subset rule's advice ("hold this permission too") leads nowhere against an account that holds
 * all 331 of them, the same reason `assertDeactivable` checks its owner-transfer conflict before its
 * own subset rule.
 *
 * `not_the_owner` is the deny reason `ownership-transfer.policy.ts` already uses for "the actor holds
 * the capability the guard checked, but not the one fact — being the owner — that matters here": a
 * `403`, not a `${resource}_forbidden` in disguise, and a reason the client and the audit trail
 * already know how to read. Reused rather than a fresh entry in `DENY_REASONS`, on the same closed-
 * catalogue reasoning every other policy in this directory follows.
 *
 * **The subset rule comes second**, and is the one every other rank-bound policy in this codebase
 * already states: an account may only be reached by somebody who effectively holds everything it
 * holds. `denied` is read apart from `permissions` rather than subtracted by the caller — a right the
 * organization already took away from the subject with a DENY exception is not one their reset needs
 * to be bounded by, and counting it would refuse the operation on the strength of a permission nobody
 * has. The actor's own effective set is asked through `holdsEffectively`, which folds the actor's DENY
 * exceptions out for the identical reason: a permission taken from the administrator must not be
 * worked around by resetting somebody who still has it.
 *
 * The owner is exempt from the subset rule for the same reason `assertDeactivable`'s does: their own
 * `permissions` is empty rather than complete, because ownership short-circuits the capability layers
 * rather than enumerating them, and a naive subset check would refuse the one account that holds
 * everything.
 *
 * Pure, like every file in this directory: no I/O, nothing the caller could not have computed from the
 * two already-read objects.
 */
export const assertMfaResetInBounds = (actor: Actor, subject: MfaResetSubject): void => {
  if (subject.isOwner && !actor.isOwner) {
    throw accessErrorFor('not_the_owner', 'user');
  }

  const beyondActor = permissionsBeyond(actor, subject);

  if (beyondActor !== undefined) {
    // The key travels as developer context, not into the body (`AppError.details` never reaches the
    // response): naming the permission to the caller would tell somebody who may not reach this
    // account what that account can do.
    throw accessErrorFor('permission_not_granted', 'user', { permission: beyondActor });
  }
};

/** The first permission the subject effectively holds and the actor does not — or `undefined`. */
const permissionsBeyond = (
  actor: Actor,
  subject: MfaResetSubject,
): SharedPermissions.PermissionKey | undefined => {
  if (actor.isOwner) return undefined;

  const deniedToSubject = new Set(subject.denied);

  return subject.permissions.find(
    (permission) => !deniedToSubject.has(permission) && !holdsEffectively(actor, permission),
  );
};
