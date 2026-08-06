import { type SharedPermissions } from '@bad-crm/shared';

import { authorizeCapability } from '@/domain/access/authorize.util.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { type Decision } from '@/domain/access/decision.types.js';
import { allow, deny } from '@/domain/access/decision.util.js';

export interface OverrideSubject {
  readonly userId: string;
  /** Whether the subject is the owner of the organization — from `organizations.ownerId`. */
  readonly isOwner: boolean;
}

export interface OverrideDraft {
  readonly permissionKey: SharedPermissions.PermissionKey;
  readonly effect: 'ALLOW' | 'DENY';
}

/**
 * Who may write an exception, on whom, and about what.
 *
 * Four refusals, and the order matters because each one answers a different question:
 *
 * 1. **the capability** — `permission:override` is itself a permission, and a dangerous one;
 * 2. **no DENY on the owner** (`owner_immutable`). Stated twice on purpose: here, and by a trigger
 *    in the database, because one such row makes «the owner cannot be locked out» false and leaves
 *    an organization nobody can administer. A rule the code enforces alone is a rule a script,
 *    a restore or an edited use-case gets around;
 * 3. **no escalation** (`T-IAM-09`) — an ALLOW may only hand out a permission the granter already
 *    holds. Without it `permission:override` is the only right anybody needs: grant yourself the
 *    rest. A DENY is not bounded by this rule: taking something away is not a way to gain it;
 * 4. **no self-lockout** — denying oneself the right to manage rights is the one edit that cannot be
 *    undone by the person who made it.
 *
 * Pure: the facts it needs — who the owner is, what the granter holds — are read by the use-case
 * inside its transaction.
 */
export const canWriteOverride = (
  actor: Actor,
  draft: OverrideDraft,
  subject: OverrideSubject,
): Decision => {
  const capability = authorizeCapability(actor, 'permission:override');

  if (!capability.allowed) return capability;

  if (draft.effect === 'DENY' && subject.isOwner) return deny('owner_immutable');

  // The owner holds everything by definition, so the subset rule is a tautology for them — and their
  // actor carries an *empty* permission set, because ownership short-circuits the capability layers.
  if (draft.effect === 'ALLOW' && !actor.isOwner && !actor.permissions.has(draft.permissionKey)) {
    return deny('permission_not_granted');
  }

  if (draft.effect === 'DENY' && subject.userId === actor.userId && governsRights(draft.permissionKey)) {
    return deny('self_lockout');
  }

  return allow();
};

/**
 * Removing an exception is the same question with the sides swapped.
 *
 * The one case that needs a rule of its own: deleting an **ALLOW** the actor gave themselves is
 * always fine, while deleting a **DENY** on themselves is exactly the escalation the DENY existed to
 * prevent — so it is refused as a self-assignment rather than as a lockout.
 */
export const canRemoveOverride = (
  actor: Actor,
  existing: OverrideDraft,
  subject: OverrideSubject,
): Decision => {
  const capability = authorizeCapability(actor, 'permission:override');

  if (!capability.allowed) return capability;

  if (existing.effect === 'DENY' && subject.userId === actor.userId) {
    return deny('self_assignment_forbidden');
  }

  return allow();
};

/**
 * Whether losing this permission would take away the ability to undo the loss.
 *
 * Deliberately narrow — the two keys that govern the permission model itself. A wider rule («any
 * dangerous key») would refuse legitimate self-restraint, which is a thing administrators do on
 * purpose: denying oneself `invoice:issue` while somebody else covers billing is exactly what this
 * layer is for.
 */
const governsRights = (key: SharedPermissions.PermissionKey): boolean =>
  key === 'permission:override' || key === 'role:update';
