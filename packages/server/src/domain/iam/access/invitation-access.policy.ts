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

/** The state of an invitation that already exists. */
export interface PendingInvitation {
  /** `null` while it is still an invitation; a date once it became a person. */
  readonly acceptedAt: Date | null;
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
 * expiry, which is «invite again» for somebody who may no longer be meant to arrive. The subset rule
 * is not re-applied — the composition was judged when the invitation was created, and re-judging it
 * would refuse a resend to a colleague who has since lost a right the invitation carries, leaving an
 * invitation nobody can either finish or reopen.
 */
export const canResendInvitation = (actor: Actor, invitation: PendingInvitation): Decision =>
  actOnOpen(actor, invitation, 'invitation:resend');

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
