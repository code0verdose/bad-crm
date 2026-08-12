import { atLeast, type AccessLevel } from './access-level.enums.js';
import { isPermissionKey, requiredLevel, type PermissionKey } from './permissions.catalog.js';

/**
 * Capability side of a subject: roles and per-user overrides, already folded into two sets.
 *
 * Folding happens once, server-side — `BuildActorQuery` asks the reader adapter, which turns rows
 * into the two sets. (An `EffectivePermissionsService` was named here for a while and never existed;
 * a class name in a docstring is worth grepping before trusting.) This module never reads a
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

/**
 * Which layer of the model answered — the rungs of the capability ladder, named.
 *
 * `GRANTED` covers both «a role gives it» and «a personal ALLOW gives it», because the folded view
 * above cannot tell them apart and **no decision may**: the two are the same answer. Splitting them
 * for a screen is `capabilitySource` below, and it is reporting, not deciding.
 */
export const CAPABILITY_OUTCOMES = [
  'OWNER',
  'DENIED_BY_OVERRIDE',
  'GRANTED',
  'NOT_GRANTED',
] as const;

export type CapabilityOutcome = (typeof CAPABILITY_OUTCOMES)[number];

/**
 * Layers 1–3: "is this subject allowed to do this at all, anywhere in the organization" — and by
 * which rung.
 *
 * **This is the only capability ladder in the product.** Everything that needs the answer derives
 * it from here: the boolean below, the `Decision` with a `DenyReason` in
 * `server/src/domain/access/authorize.util.ts`, and the per-permission origin the administration
 * screen renders. A second ladder written for any one of them would agree on the day it was written
 * and disagree on the day one of them was edited — and the screen that explains an administrator's
 * own permission model would then be wrong exactly when it is consulted.
 *
 * The order of the branches is the order of the model, and each one is load-bearing:
 *
 * 1. ownership first — §5 forbids writing a DENY on the owner, and a row that got there anyway (an
 *    older release, a restore, a bug) must not be able to lock an organization out of itself;
 * 2. a DENY override next: it beats every ALLOW below it;
 * 3. roles and ALLOW overrides grant; anything else refuses. Fail-closed by default.
 */
export const capabilityOutcome = (view: CapabilityView, key: PermissionKey): CapabilityOutcome => {
  if (view.isOwner) return 'OWNER';
  if (view.denied.has(key)) return 'DENIED_BY_OVERRIDE';

  return view.permissions.has(key) ? 'GRANTED' : 'NOT_GRANTED';
};

/** Which rungs mean «yes». The one place the allow/deny line is drawn. */
export const outcomeAllows = (outcome: CapabilityOutcome): boolean =>
  outcome === 'OWNER' || outcome === 'GRANTED';

/** Layers 1–3 as the plain boolean most callers want. Derived, never restated. */
export const effectivePermission = (view: CapabilityView, key: PermissionKey): boolean =>
  outcomeAllows(capabilityOutcome(view, key));

/**
 * The same rungs, with the granted one split by where the grant came from.
 *
 * What the administration screen of STORY-011-11 shows next to every permission: inherited from a
 * role, widened by a personal exception, taken away by one, or never granted. `OWNER` is its own
 * answer rather than «granted by everything», because ownership is not a grant anybody made and
 * cannot be taken back by editing one.
 */
export const CAPABILITY_SOURCES = [
  'OWNER',
  'OVERRIDE_DENY',
  'OVERRIDE_ALLOW',
  'ROLE',
  'NOT_GRANTED',
] as const;

export type CapabilitySource = (typeof CAPABILITY_SOURCES)[number];

export const sourceAllows = (source: CapabilitySource): boolean =>
  source === 'OWNER' || source === 'OVERRIDE_ALLOW' || source === 'ROLE';

/**
 * Where the capability answer came from — reporting on the ladder, not a second walk down it.
 *
 * `allowedByOverride` is the subset of `view.permissions` that arrived through an ALLOW exception
 * rather than through a role; it is the one fact the folded view drops, and the caller that wants
 * an origin is the caller that already read the exception rows. It is required rather than
 * defaulted, because a default would answer `ROLE` for a grant that came from an exception — an
 * unobservable lie today and a wrong screen the first time somebody reads the field.
 *
 * **Attribution never moves an answer across the allow/deny line.** `OVERRIDE_ALLOW` and `ROLE` are
 * both allowing, and the outcome they refine is the same `GRANTED`; the property is asserted over
 * every shape of view in `test/permissions/capability-source.test.ts`. That is what makes it safe
 * for the screen and the guard to share one ladder.
 */
export const capabilitySource = (
  view: CapabilityView,
  key: PermissionKey,
  allowedByOverride: ReadonlySet<PermissionKey>,
): CapabilitySource => {
  const outcome = capabilityOutcome(view, key);

  if (outcome === 'OWNER') return 'OWNER';
  if (outcome === 'DENIED_BY_OVERRIDE') return 'OVERRIDE_DENY';
  if (outcome === 'NOT_GRANTED') return 'NOT_GRANTED';

  return allowedByOverride.has(key) ? 'OVERRIDE_ALLOW' : 'ROLE';
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
 * - ownership skips the capability layers, and the ACL level it is given already accounts for
 *   ownership: `resolveAcl` answers MANAGER for the owner on everything but the vault
 *   (`docs/security/permission-model.md`, «Про `isOwner` и ACL»). This function is therefore
 *   deliberately naive about it — it compares the level it was handed. The rule itself is enforced
 *   server-side in `domain/access/authorize.util.ts`, where forgetting it would be a way to lock an
 *   organization's owner out of its own projects.
 */
export const can = (view: CapabilityView, key: string, aclLevel?: AccessLevel): boolean => {
  if (!isPermissionKey(key)) return false;
  if (!effectivePermission(view, key)) return false;

  const need = requiredLevel(key);

  if (need === null) return true;
  if (aclLevel === undefined) return false;

  return atLeast(aclLevel, need);
};
