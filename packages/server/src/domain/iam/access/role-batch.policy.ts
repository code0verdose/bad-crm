import { type SharedPermissions } from '@bad-crm/shared';

import { authorizeCapability, holdsEffectively } from '@/domain/access/authorize.util.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { dangerousAmong } from '@/domain/iam/access/role-composition.policy.js';

/** One cell-group of the draft: what a role granted, and what it would grant. */
export interface RoleChange {
  readonly roleId: string;
  readonly key: string;
  readonly isSystem: boolean;
  readonly before: readonly SharedPermissions.PermissionKey[];
  readonly after: readonly SharedPermissions.PermissionKey[];
}

/**
 * Where the actor's own rights come from, as the draft is about to change them.
 *
 * `byRole` is only the roles the actor **holds** — the ones a change could take something away
 * from. `fromOverrides` is their personal ALLOW exceptions, which no role edit can touch and which
 * therefore keep a right alive on their own.
 */
export interface ActorHoldings {
  readonly byRole: ReadonlyMap<string, readonly SharedPermissions.PermissionKey[]>;
  readonly fromOverrides: ReadonlySet<SharedPermissions.PermissionKey>;
}

export interface RoleChangeVerdict {
  readonly roleId: string;
  /** `null` when the change may be applied. */
  readonly reason: SharedPermissions.DenyReason | null;
  readonly added: readonly SharedPermissions.PermissionKey[];
  readonly removed: readonly SharedPermissions.PermissionKey[];
  /** Dangerous keys **arriving** — the ones the screen has to warn about before saving. */
  readonly dangerous: readonly SharedPermissions.PermissionKey[];
}

/**
 * The rights whose loss cannot be undone from inside, and the reason this is narrow: see
 * `role-composition.policy.ts`. Kept in step with it deliberately — two lists would mean two answers
 * to «may I still edit roles afterwards», depending on whether the edit arrived one at a time or as
 * a draft.
 */
const GOVERNS_RIGHTS: readonly SharedPermissions.PermissionKey[] = ['role:update', 'role:delete'];

/**
 * Judges a whole draft of role changes, one verdict per change.
 *
 * Two rules are per change — the subset rule (a role may only contain what its author effectively
 * holds, `T-IAM-09`) and system-role immutability — and one is not: **self-lockout is asked once,
 * against the state the draft would leave behind.** Moving `role:update` out of one role the author
 * holds and into another is a thing administrators do on purpose, and judging the halves separately
 * refuses it on the strength of a state that never exists.
 *
 * The verdicts carry what changed as well as whether it may. The screen needs both before it saves —
 * «what will this add, what will it remove, how many people does it affect» — and computing the
 * difference twice, here and in the client, is how the two drift apart.
 */
export const judgeRoleChanges = (
  actor: Actor,
  changes: readonly RoleChange[],
  holdings: ActorHoldings,
): readonly RoleChangeVerdict[] => {
  /**
   * The capability to save at all, asked **here** rather than only at the route.
   *
   * The preview runs under `role:read`, because the summary is for everybody who may look at the
   * matrix. But the question it answers is «would the server accept this», and for somebody without
   * `role:update` the honest answer is no — for every change. Leaving it to the route guard would
   * let the screen offer a Save that is refused a second later, which is exactly the disagreement
   * between the summary and the outcome this endpoint exists to prevent.
   */
  const mayEdit = authorizeCapability(actor, 'role:update');
  const lost = rightsTheActorLoses(actor, changes, holdings);

  return changes.map((change) => {
    const added = change.after.filter((key) => !change.before.includes(key));
    const removed = change.before.filter((key) => !change.after.includes(key));
    const facts = { added, removed, dangerous: dangerousAmong(added) };

    const reason = mayEdit.allowed ? refusalFor(actor, change, lost, holdings) : mayEdit.reason;

    return { roleId: change.roleId, reason, ...facts };
  });
};

const refusalFor = (
  actor: Actor,
  change: RoleChange,
  lost: ReadonlySet<SharedPermissions.PermissionKey>,
  holdings: ActorHoldings,
): SharedPermissions.DenyReason | null => {
  // Their composition is `SYSTEM_ROLE_PERMISSIONS`, re-applied on every upgrade: an edit here would
  // look like it worked and vanish on the next release.
  if (change.isSystem) return 'system_role_immutable';

  if (!change.after.every((key) => holdsEffectively(actor, key))) return 'permission_not_granted';

  if (actor.isOwner) return null;

  // Attributed to the change that takes the right away, not to the draft. Refusing all twelve cells
  // because one of them locked the author out would leave the screen unable to say which one, and
  // «something in here is wrong» is not an answer anybody can act on.
  const takesAwayForGood =
    holdings.byRole.has(change.roleId) &&
    change.before.some((key) => lost.has(key) && !change.after.includes(key));

  return takesAwayForGood ? 'self_lockout' : null;
};

/**
 * Which governing rights the draft takes away from the actor **for good**.
 *
 * Two conditions, and both are needed. A right has to actually leave a role the actor holds — a role
 * they do not hold losing it is not a state they need protecting from — and it has to be absent from
 * everything they are left with: their other roles as the draft leaves them, the drafted composition
 * of the roles in it, and their personal ALLOW exceptions, which no role edit can touch.
 *
 * This is what makes «move the right from one role to another» a legal draft: the first change
 * removes it, the second puts it back, and the answer is about the end state rather than the halves.
 */
const rightsTheActorLoses = (
  actor: Actor,
  changes: readonly RoleChange[],
  holdings: ActorHoldings,
): ReadonlySet<SharedPermissions.PermissionKey> => {
  const kept = new Set<SharedPermissions.PermissionKey>(holdings.fromOverrides);
  const changed = new Map(changes.map((change) => [change.roleId, change.after]));

  for (const [roleId, permissions] of holdings.byRole) {
    for (const key of changed.get(roleId) ?? permissions) kept.add(key);
  }

  const removedFromHeld = new Set(
    changes
      .filter((change) => holdings.byRole.has(change.roleId))
      .flatMap((change) => change.before.filter((key) => !change.after.includes(key))),
  );

  return new Set(
    GOVERNS_RIGHTS.filter(
      (key) => removedFromHeld.has(key) && holdsEffectively(actor, key) && !kept.has(key),
    ),
  );
};
