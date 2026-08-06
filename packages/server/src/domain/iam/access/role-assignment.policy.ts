import { type SharedPermissions } from '@bad-crm/shared';

import { type Actor } from '@/domain/access/actor.types.js';
import { type Decision } from '@/domain/access/decision.types.js';
import { allow, deny } from '@/domain/access/decision.util.js';
import { authorizeCapability, holdsEffectively } from '@/domain/access/authorize.util.js';

/** What the decision needs to know about the role being handed out or taken away. */
export interface RoleUnderAssignment {
  readonly roleId: string;
  readonly key: string;
  /** Everything the role grants, in full — a subset check cannot be made against a summary. */
  readonly permissions: readonly SharedPermissions.PermissionKey[];
}

export interface AssignmentSubject {
  readonly userId: string;
  /** Roles the subject already holds, after the operation being judged. */
  readonly rolesAfter: readonly string[];
}

/**
 * Who may give a role to whom — the rules that stop one administrator becoming all of them.
 *
 * Four separate refusals, because they answer four different questions and a caller has to be able
 * to tell them apart:
 *
 * - **`role:assign` at all** — the ordinary capability.
 * - **No escalation** (`T-IAM-09`): a role may only be granted by somebody who already holds
 *   everything it grants. Without this rule `role:assign` is the only permission anybody needs —
 *   grant yourself a role that has the rest.
 * - **No self-assignment**: even when the subset rule holds, handing yourself a role removes the
 *   second pair of eyes from every escalation, and the trail then shows one person approving their
 *   own access. The refusal is separate from the subset rule on purpose — the two are different
 *   sentences in the interface.
 * - **No self-lockout, no last owner**: the two states an organization cannot recover from without
 *   somebody outside it. Both are conflicts (409) rather than denials: the caller *may* do this, and
 *   the current state is what refuses.
 *
 * Pure, and deliberately ignorant of how any of it is stored: the counts and sets it takes are what
 * the use-case reads inside its transaction.
 */
export const canAssignRole = (
  actor: Actor,
  role: RoleUnderAssignment,
  subject: AssignmentSubject,
): Decision => {
  const capability = authorizeCapability(actor, 'role:assign');

  if (!capability.allowed) return capability;

  // The owner is the one account that is not bounded by the subset rule — they already hold
  // everything by definition, so the check would be a tautology, and `permissions` on their actor is
  // empty rather than complete (ownership short-circuits the capability layers).
  if (!actor.isOwner) {
    // Effectively held, so that a DENY override on the assigner is not worked around by handing
    // somebody else a role that carries the denied key (`holdsEffectively`).
    const missing = role.permissions.find((permission) => !holdsEffectively(actor, permission));

    if (missing !== undefined) return deny('permission_not_granted');
  }

  if (subject.userId === actor.userId) return deny('self_assignment_forbidden');

  return allow();
};

/**
 * Whether a role may be taken away — the same capability question, plus the two states of no return.
 *
 * `ownersAfter` is counted **inside the transaction** that performs the revocation: counted before,
 * it is a decision made against a state two concurrent revocations both saw, and the organization
 * ends with no owner because each of them believed the other one was still there.
 */
export const canRevokeRole = (
  actor: Actor,
  role: RoleUnderAssignment,
  subject: AssignmentSubject,
  ownersAfter: number,
): Decision => {
  const capability = authorizeCapability(actor, 'role:revoke');

  if (!capability.allowed) return capability;

  if (role.key === 'owner' && ownersAfter < 1) return deny('last_owner_required');

  // Taking away one's own last way back in. Refused rather than confirmed, because the person who
  // could undo it is the person who just lost the right to.
  if (subject.userId === actor.userId && subject.rolesAfter.length === 0) {
    return deny('self_lockout');
  }

  return allow();
};
