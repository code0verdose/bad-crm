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
  /** The counter carried in the access token; a stale one means the view must be rebuilt. */
  readonly permissionsVersion: number;
}

export interface EffectivePermissionsReaderPort {
  /** `null` when the person is not in this organization — answered as 404, never 403. */
  capabilitiesOf(userId: string): Promise<CapabilityFacts | null>;
}
