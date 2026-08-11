import { type SharedPermissions } from '@bad-crm/shared';

/**
 * What the permission layers know about one person, read in the tenant the caller opened.
 *
 * Deliberately not «the user»: no email, no name, no status. A reader that returned the row would
 * let a policy decide something by a field that is not a permission, which is the second point of
 * authorization the model exists to forbid.
 */
export interface CapabilityFacts {
  /**
   * The owner of the organization, from `organizations.owner_id`.
   *
   * A denormalised flag rather than «holds the role named owner»: ownership is the one property that
   * must be answerable when the roles table is unreachable or wrong, and the schema already makes it
   * non-null (`docs/architecture/data-model.md`, «Про циклический ключ»).
   */
  readonly isOwner: boolean;
  /**
   * Everything the person may do: what their unexpired roles grant, plus unexpired ALLOW
   * exceptions, deduplicated.
   */
  readonly granted: readonly SharedPermissions.PermissionKey[];
  /**
   * Unexpired DENY exceptions. Kept separate rather than subtracted here, because the two are not
   * the same statement: `effectivePermission` reads a DENY as «refused, and here is why»
   * (`denied_by_override`), while a missing grant is «nobody gave it to you». The interface offers a
   * different remedy for each.
   */
  readonly denied: readonly SharedPermissions.PermissionKey[];
  /**
   * Keys of the roles the person holds, unexpired ones only.
   *
   * Not used by any decision — the decision is made from `granted` and `denied` — but it is what the
   * interface shows next to «why»: «you may do this because you are a manager» is an answer a person
   * can act on, and «you have the permission» is not.
   */
  readonly roleKeys: readonly string[];
  /** The counter carried in the access token; a stale one means the view must be rebuilt. */
  readonly permissionsVersion: number;
}

/** One role the subject holds, as the interface names it rather than as a key. */
export interface HeldRole {
  readonly roleId: string;
  readonly key: string;
  readonly name: string;
}

/**
 * The exception on one key, with everything that explains it.
 *
 * Expired rows never appear here: an exception whose `expiresAt` has passed grants and denies
 * nothing from that moment, whether or not the hourly cleaner has run, so a screen that showed it
 * would show a rule that is not in force.
 *
 * `grantedById` and no name or address. Who wrote it is an id the caller resolves against the
 * directory it already has; putting a person's name in the answer to «what may Ivan do» would put
 * it in the logs and the caches of an operation that has no business carrying one.
 */
export interface OverrideFacts {
  readonly effect: 'ALLOW' | 'DENY';
  readonly reason: string;
  /** `null` where the grantor's account has since been deleted (`ON DELETE SET NULL`). */
  readonly grantedById: string | null;
  readonly grantedAt: Date;
  readonly expiresAt: Date | null;
}

/**
 * The same capability facts, plus where each part of them came from.
 *
 * Two properties make this safe to have beside `capabilitiesOf` rather than dangerous:
 *
 * **`facts` is the identical fold, not a second one.** The adapter reads the rows once and projects
 * them twice; the expiry predicate and the «a deprecated permission grants nothing» filter are
 * written in one place. A separate read model assembled from its own query is how «the screen says
 * he may, the server says he may not» happens.
 *
 * **Attribution decides nothing.** `grantedByRole` and `overrides` are what the answer is *narrated*
 * with. The answer itself is `SharedPermissions.capabilityOutcome` over `facts`, the same ladder the
 * guard walks.
 */
export interface AttributedCapabilityFacts {
  readonly facts: CapabilityFacts;
  readonly roles: readonly HeldRole[];
  /**
   * For every key at least one held role grants: the ids of those roles.
   *
   * Reported whether or not the key is in force, because that is the question the three-state
   * control asks — «if I remove this exception, what does he fall back to?» A screen that only
   * learnt about roles for keys the roles won could not answer it, and would offer «inherited» as a
   * state whose meaning it cannot show.
   */
  readonly grantedByRole: ReadonlyMap<SharedPermissions.PermissionKey, readonly string[]>;
  readonly overrides: ReadonlyMap<SharedPermissions.PermissionKey, OverrideFacts>;
}

export interface EffectivePermissionsReaderPort {
  /** `null` when the person is not in this organization — answered as 404, never 403. */
  capabilitiesOf(userId: string): Promise<CapabilityFacts | null>;
  /**
   * The same read, narrated — for the one screen that has to explain the answer instead of using it.
   *
   * Separate from `capabilitiesOf` because that one runs on **every request** to build the actor:
   * making it always assemble a key-to-roles map would spend the work of the administration screen
   * on every page load in the product.
   */
  attributedCapabilitiesOf(userId: string): Promise<AttributedCapabilityFacts | null>;
}
