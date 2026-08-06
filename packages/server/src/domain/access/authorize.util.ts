import { SharedPermissions } from '@bad-crm/shared';

import { type Actor } from '@/domain/access/actor.types.js';
import { type Decision } from '@/domain/access/decision.types.js';
import { allow, deny } from '@/domain/access/decision.util.js';

/**
 * What an access reader answers about one resource — a scope, never the entity.
 *
 * Three states rather than «level or null», because the three refusals they produce are different
 * answers to the caller: 404 for a resource that is not there (or not theirs), 503 for an ACL the
 * server could not read, and 403 for a level that is genuinely too low. Collapsing the middle one
 * into «no level» is the classic fail-open in disguise: «we could not check» would become «no
 * access» in the log and «probably fine» in the next refactor.
 */
export type AclScope =
  | {
      readonly status: 'resolved';
      readonly organizationId: string;
      readonly level: SharedPermissions.AccessLevel;
      /**
       * Which family the object belongs to — and therefore whether the owner of the organization
       * bypasses the level on it.
       *
       * Required, not optional with a default, because the safe value differs by family and a
       * forgotten field would silently pick one of them. `vault` is the single exception the model
       * names: there access follows from holding a `wrappedVaultKey`, no permission substitutes for
       * a key, and the owner reads somebody else's vault only through the escrow procedure
       * (`docs/security/permission-model.md`, «Про `isOwner` и ACL»).
       */
      readonly family: 'standard' | 'vault';
    }
  /** The reader found nothing: the row does not exist, is deleted, or belongs to another tenant. */
  | { readonly status: 'missing' }
  /** The reader itself failed — a timeout, an unreachable database, a broken inheritance chain. */
  | { readonly status: 'unavailable' };

/**
 * Layers 1–3: may this caller do this at all, anywhere in the organization.
 *
 * The order of the branches is the order of the model, and each one is load-bearing:
 *
 * 1. no actor → `not_authenticated` (401), because «anonymous» is not «has no permission»;
 * 2. a key outside the catalogue → `unknown_permission`, so a typo or a permission deleted from a
 *    release never becomes «no check at all»;
 * 3. ownership → allow. Read **before** the DENY overrides on purpose: §5 forbids writing a DENY on
 *    the owner, and a row that got there anyway — an older release, a restore, a bug — must not be
 *    able to lock an organization out of itself;
 * 4. a DENY override → refuse. It beats every ALLOW below it;
 * 5. roles and ALLOW overrides → allow; anything else → refuse. Fail-closed by default.
 */
export const authorizeCapability = (actor: Actor | null, key: string): Decision => {
  if (actor === null) return deny('not_authenticated');
  if (!SharedPermissions.isPermissionKey(key)) return deny('unknown_permission');
  if (actor.isOwner) return allow();
  if (actor.denied.has(key)) return deny('denied_by_override');

  return actor.permissions.has(key) ? allow() : deny('permission_not_granted');
};

/**
 * Does the actor **effectively** hold this key — the question every «you may not grant what you do
 * not have» rule has to ask.
 *
 * `actor.permissions` is roles plus ALLOW overrides and does **not** subtract the DENY overrides:
 * they live in `actor.denied` and are applied by the decision above. So a rule that reads the set
 * directly treats a denied key as held, and the organization's way of taking one right away from
 * one person becomes a formality — compose a role containing it, hand the role to a second account,
 * have that account lift the DENY. This is the one place that folding happens, so that all three
 * subset rules (composition, assignment, overrides) agree.
 *
 * Ownership short-circuits, exactly as in `authorizeCapability`: the owner's set is empty because
 * ownership replaces the layers rather than enumerating them.
 */
export const holdsEffectively = (actor: Actor, key: SharedPermissions.PermissionKey): boolean =>
  actor.isOwner || (!actor.denied.has(key) && actor.permissions.has(key));

/**
 * Layer 4: the resource half of the conjunction, once the capability has passed.
 *
 * Exported for the two-step flow below and for use-cases that already hold a scope; on its own it is
 * **not** an authorization — a level without a capability grants nothing, which is what the
 * `authorize` composition and the table-driven test exist to keep true.
 */
export const authorizeResource = (
  actor: Actor,
  key: SharedPermissions.PermissionKey,
  scope: AclScope | undefined,
): Decision => {
  const need = SharedPermissions.requiredLevel(key);

  if (need === null) return allow();
  if (scope === undefined) return deny('resource_required');
  if (scope.status === 'missing') return deny('resource_not_found');
  if (scope.status === 'unavailable') return deny('acl_resolution_failed');
  if (scope.organizationId !== actor.organizationId) return deny('tenant_mismatch');

  // The owner clears the level on everything but the vault — `resolveAcl → MANAGER` in the model.
  // Placed here rather than left to each access reader on purpose: «owner неотзываем» is a stated
  // guarantee, and it is false the moment one reader forgets, because an administrator putting NONE
  // on the root project would then lock the organization's owner out of it. What the owner does not
  // clear is the tenant check above — a foreign object is never theirs — nor a missing one.
  if (actor.isOwner && scope.family === 'standard') return allow();

  if (scope.level === 'NONE') return deny('acl_explicit_none');

  return SharedPermissions.atLeast(scope.level, need) ? allow() : deny('insufficient_acl_level');
};

/**
 * The whole decision, for a caller that already resolved the scope.
 *
 * The conjunction of the two layers — capability **and** resource level — in the order the model
 * states: nothing about the object is consulted until the capability holds.
 */
export const authorize = (actor: Actor | null, key: string, scope?: AclScope): Decision => {
  const capability = authorizeCapability(actor, key);

  if (!capability.allowed || actor === null || !SharedPermissions.isPermissionKey(key)) {
    return capability;
  }

  return authorizeResource(actor, key, scope);
};

/**
 * The same decision when resolving the scope costs a query — the form use-cases should call.
 *
 * The resolver is a function, not a value, and that is the entire point: it is invoked only after
 * the capability passed and only for a permission that has a resource context. A caller without the
 * right is therefore refused **before** the database is touched — one round trip nobody needs, and,
 * more importantly, no difference in elapsed time between «you have no permission» and «that object
 * does not exist» (`docs/security/permission-model.md` §5).
 *
 * Async and still pure in the sense the layer requires: it performs no I/O of its own and imports
 * nothing outside the domain — the I/O belongs to the port the use-case passes in.
 */
export const authorizeWith = async (
  actor: Actor | null,
  key: string,
  resolveScope: () => Promise<AclScope>,
): Promise<Decision> => {
  const capability = authorizeCapability(actor, key);

  if (!capability.allowed || actor === null || !SharedPermissions.isPermissionKey(key)) {
    return capability;
  }

  if (SharedPermissions.requiredLevel(key) === null) return allow();

  return authorizeResource(actor, key, await resolveScope());
};
