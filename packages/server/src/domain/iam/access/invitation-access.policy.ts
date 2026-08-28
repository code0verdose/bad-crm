import { type SharedPermissions } from '@bad-crm/shared';

import { authorizeCapability, holdsEffectively } from '@/domain/access/authorize.util.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { type Decision } from '@/domain/access/decision.types.js';
import { allow, deny } from '@/domain/access/decision.util.js';

/** What an invitation would hand out: the composition of the role attached to it. */
export interface InvitationDraft {
  readonly email: string;
  readonly rolePermissions: readonly SharedPermissions.PermissionKey[];
}

/**
 * The state of an invitation that already exists — as much as *closing* it needs to know.
 *
 * Revoking is bounded by the capability and by the invitation still being open, and by nothing else:
 * shutting a door nobody walked through hands out no rights, so what the invitation carried does not
 * enter the decision.
 */
export interface PendingInvitation {
  /** `null` while it is still an invitation; a date once it became a person. */
  readonly acceptedAt: Date | null;
}

/**
 * The same, plus what *reopening* it needs: the composition it would hand out.
 *
 * A separate type rather than an optional field, so the difference is visible in the signature —
 * a resend is bounded by the subset rule and a revoke is not, and that is the whole reason the two
 * capabilities are separate keys.
 */
export interface ResendableInvitation extends PendingInvitation {
  /** What the role attached to it would hand out — the composition `canInvite` is bounded by. */
  readonly rolePermissions: readonly SharedPermissions.PermissionKey[];
}

/**
 * Who may invite somebody, and with what.
 *
 * An invitation is **a role assignment written in advance**, and it inherits the rule that bounds
 * every other way of handing out rights (`T-IAM-09`): the role attached to it may only contain what
 * the inviter effectively holds. Without that bound, `invitation:create` is the widest permission in
 * the product — a way to create an account that can do more than its author, and then sign in as
 * somebody who is not on anybody's list of administrators.
 *
 * «Effectively» is the same folding the other subset rules use (`holdsEffectively`): a right the
 * organization took away from this person with a personal DENY is not theirs to hand to a new
 * account. The owner is exempt for the reason their actor shows — ownership short-circuits the
 * capability layers, so their permission set is empty rather than complete.
 */
export const canInvite = (actor: Actor, draft: InvitationDraft): Decision => {
  const capability = authorizeCapability(actor, 'invitation:create');

  if (!capability.allowed) return capability;
  if (actor.isOwner) return allow();

  return draft.rolePermissions.every((permission) => holdsEffectively(actor, permission))
    ? allow()
    : deny('permission_not_granted');
};

/**
 * Reopening a door that was closing.
 *
 * Its own capability, because it is its own risk: a resend mints a **new** token and extends the
 * expiry, which is «invite again» for somebody who may no longer be meant to arrive.
 *
 * **And the subset rule holds here too, since 2026-08-28.** It used to be skipped, on the reasoning
 * that «the composition was judged when the invitation was created, and re-judging it would refuse a
 * resend to a colleague who has since lost a right the invitation carries». That is true about the
 * composition and beside the point about the actor: the person reopening the door is not the person
 * who opened it. Reproduced against a running stack — `manager` holds `invitation:resend` and not
 * `role:assign`, so `POST /invitations` with the `admin` role is refused `403`, while
 * `POST /invitations/{id}/resend` on somebody else's `admin` invitation answered `200` **with the
 * plaintext `inviteUrl` in the body**; accepting that link created an `admin` account on a password
 * the manager had just chosen. A capability named `resend` cannot be a way around the one named
 * `create`.
 *
 * The case the old reasoning worried about — an invitation nobody can finish or reopen — is real and
 * cheaper: it is closed by revoking it (`invitation:revoke`) and inviting again by somebody whose
 * rights cover the role. That path leaves an audit trail on both halves; the old one left an
 * escalation.
 */
export const canResendInvitation = (actor: Actor, invitation: ResendableInvitation): Decision => {
  const open = actOnOpen(actor, invitation, 'invitation:resend');

  if (!open.allowed) return open;
  if (actor.isOwner) return allow();

  return invitation.rolePermissions.every((permission) => holdsEffectively(actor, permission))
    ? allow()
    : deny('permission_not_granted');
};

/** Closing it early. Its own capability for the same reason: a different risk from creating one. */
export const canRevokeInvitation = (actor: Actor, invitation: PendingInvitation): Decision =>
  actOnOpen(actor, invitation, 'invitation:revoke');

/**
 * An accepted invitation is not an invitation any more, it is a person.
 *
 * Resending would mint a token for an account that already exists; revoking would suggest their
 * access can be taken back this way, and it cannot — that is deactivation, a different operation
 * with a different trail. So both refuse, and they refuse with a sentence that says which of the two
 * the caller wants (`invitation_already_accepted`, 409) rather than pretending the row is missing.
 */
const actOnOpen = (
  actor: Actor,
  invitation: PendingInvitation,
  key: SharedPermissions.PermissionKey,
): Decision => {
  const capability = authorizeCapability(actor, key);

  if (!capability.allowed) return capability;

  return invitation.acceptedAt === null ? allow() : deny('invitation_already_accepted');
};
