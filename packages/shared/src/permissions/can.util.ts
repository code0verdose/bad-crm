import { atLeast, type AccessLevel } from './access-level.enums.js';
import { isPermissionKey, requiredLevel, type PermissionKey } from './permissions.catalog.js';

/**
 * Capability side of a subject: roles and per-user overrides, already folded into two sets.
 *
 * Folding happens once, server-side, in `EffectivePermissionsService`; this module never reads a
 * database. That is what makes it importable by the client for UI hints without shipping any
 * authorisation logic that the client could be tricked into deciding on its own — the authority is
 * always the server (invariant 2 in CLAUDE.md).
 */
export interface CapabilityView {
  readonly isOwner: boolean;
  /** Roles plus ALLOW overrides. */
  readonly permissions: ReadonlySet<PermissionKey>;
  /** DENY overrides — they beat everything except ownership. */
  readonly denied: ReadonlySet<PermissionKey>;
}

/** Layers 1–3: "is this subject allowed to do this at all, anywhere in the organization". */
export const effectivePermission = (view: CapabilityView, key: PermissionKey): boolean => {
  if (view.isOwner) return true;
  if (view.denied.has(key)) return false;
  return view.permissions.has(key);
};

/**
 * The single place a permission decision is computed (layer 5).
 *
 * The result is a **conjunction**: the capability *and* the resource ACL. `task:update` without
 * EDITOR on the board is a deny, and EDITOR without `task:update` is a deny too. Every branch
 * below fails closed on purpose:
 *
 * - an unknown key denies, so a typo never opens access;
 * - a resource-scoped key with no level supplied denies, because "not passed" is not "allowed";
 * - ownership skips the capability layers but not the ACL — the object still has to be one the
 *   owner has a level on.
 */
export const can = (view: CapabilityView, key: string, aclLevel?: AccessLevel): boolean => {
  if (!isPermissionKey(key)) return false;
  if (!effectivePermission(view, key)) return false;

  const need = requiredLevel(key);

  if (need === null) return true;
  if (aclLevel === undefined) return false;

  return atLeast(aclLevel, need);
};
