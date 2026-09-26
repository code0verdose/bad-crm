import { type SharedPermissions } from '@bad-crm/shared';

/**
 * Roles of the current tenant, and what they grant.
 *
 * No method takes an `organizationId`: the tenant is the scope the caller opened through
 * `UnitOfWorkPort`, and a parameter beside it would be a second answer to the same question — one
 * the policy silently overrules, turning a mismatch into an empty result rather than into an error
 * (rules/tenancy-rls.mdc, 9).
 */

export interface SystemRoleDraft {
  /** `owner` | `admin` | … — the key of a system role, unique inside the organization. */
  readonly key: SharedPermissions.SystemRoleKey;
  readonly name: string;
  readonly isDefault: boolean;
  /** Higher wins where two roles are displayed in order; not part of any access decision. */
  readonly priority: number;
  readonly permissions: readonly SharedPermissions.PermissionKey[];
}

export interface RoleSummary {
  readonly id: string;
  readonly key: string;
  readonly isSystem: boolean;
  readonly isDefault: boolean;
  readonly permissionCount: number;
}

/**
 * What provisioning did to one system role, as the trail needs to read it.
 *
 * The composition of a system role is code, so an upgrade can move the rights of every organization
 * in an installation at once. `before`/`after` therefore carry the **delta** and the sizes rather
 * than the two full lists: the lists are `SYSTEM_ROLE_PERMISSIONS` of the two releases and are
 * recomputable from them, while «which keys moved, in this organization, on this run» is the fact
 * nothing else records — and `owner` alone would otherwise write the whole catalogue into the trail
 * twice per organization.
 */
export interface SystemRoleChange {
  readonly roleId: string;
  readonly key: SharedPermissions.SystemRoleKey;
  /** `false` when this run created the row — a role the release added to an existing installation. */
  readonly existedBefore: boolean;
  readonly countBefore: number;
  readonly countAfter: number;
  readonly granted: readonly SharedPermissions.PermissionKey[];
  readonly revoked: readonly SharedPermissions.PermissionKey[];
}

/**
 * The result of a provisioning run: what the organization now has, and what actually moved.
 *
 * `changes` is empty for an idempotent re-run, which is what keeps the trail readable — an
 * installation carrying hundreds of organizations re-provisions all of them on every upgrade, and a
 * record per organization per run would bury the one release that did change something.
 */
export interface SystemRoleProvisioning {
  readonly roles: readonly RoleSummary[];
  /**
   * How many of the drafted roles the organization already had.
   *
   * `0` means this is a first provisioning — a fresh organization, whose seven roles are what
   * `organization.registered` already says it was given, not a change of anybody's rights.
   */
  readonly preexistingCount: number;
  readonly changes: readonly SystemRoleChange[];
}

export interface RoleRepositoryPort {
  /**
   * Writes the system roles of the current organization and the permissions they grant.
   *
   * **Idempotent, and re-applying is the point.** It runs when an organization is created and again
   * on upgrade, because the composition of a system role is code: a key added to
   * `SYSTEM_ROLE_PERMISSIONS` has to reach every installation that already exists, and the only
   * alternative — a migration per matrix change — would mean a migration nobody writes.
   *
   * **Custom roles are never touched.** They belong to the organization, not to the release, and an
   * upgrade that rewrote them would be an upgrade that silently changes who can do what.
   */
  provisionSystemRoles(drafts: readonly SystemRoleDraft[]): Promise<SystemRoleProvisioning>;

  /** Every role of the current organization, system and custom alike. */
  listRoles(): Promise<readonly RoleSummary[]>;
}

/** A custom role as the composition screen edits it. */
export interface RoleDraft {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly permissions: readonly SharedPermissions.PermissionKey[];
}

export interface RoleComposition {
  readonly roleId: string;
  readonly key: string;
  readonly name: string;
  /** Carried so that an edit of the composition cannot silently erase it. */
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly permissions: readonly SharedPermissions.PermissionKey[];
}

/**
 * A role as the administration screen lists it: the composition plus how many people hold it.
 *
 * The holder count is part of the row rather than a second request per role, because the screen that
 * reads this renders every role beside every permission — and «how many people does this change
 * affect» is the question asked before each edit, not after.
 */
export interface RoleListEntry {
  readonly roleId: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly isDefault: boolean;
  readonly holderCount: number;
  readonly permissions: readonly SharedPermissions.PermissionKey[];
}

/**
 * Custom roles — the half of the layer that belongs to the organization rather than to the release.
 *
 * Separate from `RoleRepositoryPort` because the two have opposite lifecycles: system roles are
 * re-applied on every upgrade and must never be edited, while these exist because an organization
 * needed a role the product does not ship. Mixing them in one interface is how an upgrade path ends
 * up rewriting somebody's own role.
 */
export interface CustomRoleRepositoryPort {
  /** Every role of this organization with what it grants — system roles included, read-only. */
  list(): Promise<readonly RoleListEntry[]>;

  /** `null` when the role is not in this organization — answered 404, never 403. */
  composition(roleId: string): Promise<RoleComposition | null>;

  /** Rejects a duplicate key with the conflict the caller reports as `role_already_exists`. */
  create(draft: RoleDraft): Promise<string>;

  /**
   * Replaces the grants wholesale: a permission removed from the draft is removed from the role.
   *
   * `false` when the role was not there to update — it was read a moment earlier, so this means it
   * was deleted in between, and the caller has to answer that the way it answers every other absent
   * role. Without the answer the grants would be written against a row that no longer exists.
   */
  update(roleId: string, draft: Omit<RoleDraft, 'key'>): Promise<boolean>;

  remove(roleId: string): Promise<void>;

  /**
   * Locks the role row `FOR UPDATE` for the rest of the caller's transaction; `false` when it is
   * not in this organization (any more).
   *
   * Taken by the deletion as its **first** statement — before the policy reads the composition and
   * the actor's holding (the re-gate's L-2), and so before it removes the role's `ResourceAcl`
   * grants (the gate's M-1). A grant reads the role `FOR KEY SHARE`
   * (`AclRepositoryPort.subjectExists`), so the two now serialize: a grant already in flight is
   * committed before the deletion collects the role's grants, and a grant arriving later waits and
   * then finds no role. Without it the deletion's
   * `removeAllOfSubject` and its `DELETE FROM roles` leave a window in which a grant commits and
   * outlives the role.
   */
  lockForRemoval(roleId: string): Promise<boolean>;

  /**
   * The compositions of several roles at once, for a draft that spans them.
   *
   * One read rather than one per role: the matrix screen saves a dozen changes together, and a
   * repository walked once per change would also mean a dozen round trips inside the transaction
   * everybody else is waiting on. Roles of another organization are simply absent from the answer,
   * which is how the caller learns they do not exist here.
   */
  compositionsOf(roleIds: readonly string[]): Promise<readonly RoleComposition[]>;

  /**
   * What one person's rights are made of, as the self-lockout rule needs them: their roles with the
   * keys each grants, and their personal ALLOW exceptions, which no role edit can touch.
   */
  holdingsOf(userId: string): Promise<{
    readonly byRole: ReadonlyMap<string, readonly SharedPermissions.PermissionKey[]>;
    readonly fromOverrides: ReadonlySet<SharedPermissions.PermissionKey>;
  }>;

  /** How many people hold each of these roles — «who does this draft affect», in one statement. */
  holderCounts(roleIds: readonly string[]): Promise<ReadonlyMap<string, number>>;

  /**
   * Does this person hold the role — the input of the self-lockout rule.
   *
   * A question, not a list: the two callers need «is the actor among them» and «how many», and a
   * role the whole organization holds would otherwise be tens of thousands of identifiers in memory
   * on every edit. The same reason `bumpHoldersOf` exists.
   */
  holdsRole(userId: string, roleId: string): Promise<boolean>;

  /** How many people hold it — for the trail, which records the size of what changed. */
  holderCount(roleId: string): Promise<number>;

  /** What one person still gets from their **other** roles; the input of the self-lockout rule. */
  permissionsExcludingRole(
    userId: string,
    roleId: string,
  ): Promise<readonly SharedPermissions.PermissionKey[]>;

  /**
   * Invalidates whoever holds the role **as one statement**, without naming them first.
   *
   * The version of «read the holders into an array, then update those ids» has two faults: it misses
   * anybody assigned the role between the two statements — they get the new permissions while their
   * access token still says otherwise, until it expires — and it puts one bind parameter per holder
   * into the statement, which a role the whole organization holds eventually exceeds.
   *
   * The subquery removes the second fault entirely and narrows the first to the duration of one
   * statement: at READ COMMITTED the snapshot is taken when the statement starts, so an assignment
   * committed after that and before this transaction commits is still missed. Closing it completely
   * needs the role row locked for the duration (`SELECT … FOR UPDATE`), which is the same mechanism
   * the optimistic-concurrency work deferred in STORY-011-03 would bring.
   *
   * Deletion calls this **before** removing the role, because the cascade takes the assignments with
   * it and there would be nobody left to find.
   */
  bumpHoldersOf(roleId: string): Promise<void>;

  /**
   * The same for a whole draft — **one statement for every role in it**.
   *
   * A draft may carry sixty-four roles, and a round trip per role inside an interactive transaction
   * with a five-second ceiling is how a save fails on a managed database with a fifteen-millisecond
   * round trip: not because anything is wrong, but because the arithmetic ran out. One statement
   * also collapses sixty-four interleaved lock phases into one, which narrows the window in which
   * two administrators saving at once can deadlock — it does not close it, because the order the
   * rows are locked in is still the planner's.
   */
  bumpHoldersOfMany(roleIds: readonly string[]): Promise<void>;
}
