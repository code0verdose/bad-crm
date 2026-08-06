import { SharedPermissions } from '@bad-crm/shared';

import { authorizeCapability, holdsEffectively } from '@/domain/access/authorize.util.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { type Decision } from '@/domain/access/decision.types.js';
import { allow, deny } from '@/domain/access/decision.util.js';

export interface RoleComposition {
  readonly key: string;
  readonly isSystem: boolean;
  /** The keys the role would grant after the change. */
  readonly permissions: readonly SharedPermissions.PermissionKey[];
}

/** What the actor would still hold if the change went through — the self-lockout question. */
export interface ActorAfterChange {
  /** `true` when the actor holds this role themselves. */
  readonly holdsRole: boolean;
  /** Permissions the actor keeps from elsewhere — other roles and their ALLOW exceptions. */
  readonly keptElsewhere: ReadonlySet<SharedPermissions.PermissionKey>;
}

/**
 * Who may compose a role out of the catalogue, and what they may put in it.
 *
 * Four refusals, and the first two are the ones that make `role:create` less than «grant yourself
 * anything»:
 *
 * - **the capability**, per operation;
 * - **no escalation** (`T-IAM-09`): a role may only contain what the author already holds. Without
 *   it, creating a role with `user:impersonate` and handing it to nobody is still a stored capability
 *   waiting for the assignment rules to be worked around;
 * - **system roles are code, not data** (`system_role_immutable`): their composition comes from
 *   `SYSTEM_ROLE_PERMISSIONS` and is re-applied on every upgrade, so an edit here would silently
 *   disappear on the next release — worse than a refusal, because it looks like it worked;
 * - **no self-lockout**: removing from a role the right that let the actor edit roles, when they hold
 *   that role and nothing else grants it, is the one edit nobody can undo from inside.
 */
export const canCreateRole = (actor: Actor, role: RoleComposition): Decision => {
  const capability = authorizeCapability(actor, 'role:create');

  if (!capability.allowed) return capability;

  return withinActorGrants(actor, role.permissions);
};

export const canUpdateRole = (
  actor: Actor,
  role: RoleComposition,
  after: ActorAfterChange,
): Decision => {
  const capability = authorizeCapability(actor, 'role:update');

  if (!capability.allowed) return capability;
  if (role.isSystem) return deny('system_role_immutable');

  const subset = withinActorGrants(actor, role.permissions);

  if (!subset.allowed) return subset;

  return locksOutSelf(actor, role, after) ? deny('self_lockout') : allow();
};

export const canDeleteRole = (
  actor: Actor,
  role: RoleComposition,
  after: ActorAfterChange,
): Decision => {
  const capability = authorizeCapability(actor, 'role:delete');

  if (!capability.allowed) return capability;
  if (role.isSystem) return deny('system_role_immutable');

  // Deleting a role is removing all of its permissions from everybody who held it, the actor
  // included — the same lockout question with an empty «after».
  return locksOutSelf(actor, { ...role, permissions: [] }, after) ? deny('self_lockout') : allow();
};

/**
 * Whether the change would leave the actor unable to undo it.
 *
 * Narrow on purpose: only the two keys that govern the permission model itself. A wider rule would
 * refuse legitimate self-restraint — an administrator narrowing their own role while somebody else
 * covers the rest is a thing that happens deliberately.
 */
const GOVERNS_RIGHTS: readonly SharedPermissions.PermissionKey[] = ['role:update', 'role:delete'];

const locksOutSelf = (actor: Actor, role: RoleComposition, after: ActorAfterChange): boolean => {
  if (actor.isOwner || !after.holdsRole) return false;

  const kept = new Set<SharedPermissions.PermissionKey>([
    ...after.keptElsewhere,
    ...role.permissions,
  ]);

  return GOVERNS_RIGHTS.some((key) => holdsEffectively(actor, key) && !kept.has(key));
};

/**
 * The subset rule. The owner is exempt for the reason their actor shows: ownership short-circuits the
 * capability layers, so their permission set is empty rather than complete, and a naive check would
 * refuse the one account that holds everything.
 */
const withinActorGrants = (
  actor: Actor,
  permissions: readonly SharedPermissions.PermissionKey[],
): Decision => {
  if (actor.isOwner) return allow();

  // Effectively, not «is in the set»: a key the organization took away with a DENY override is not
  // the author's to put into a role, and reading the raw set would make the override a formality.
  return permissions.every((permission) => holdsEffectively(actor, permission))
    ? allow()
    : deny('permission_not_granted');
};

/** Keys the interface must confirm before they are stored: everything the catalogue marks dangerous. */
export const dangerousAmong = (
  permissions: readonly SharedPermissions.PermissionKey[],
): readonly SharedPermissions.PermissionKey[] =>
  permissions.filter((permission) => SharedPermissions.PERMISSION_META[permission].dangerous);
