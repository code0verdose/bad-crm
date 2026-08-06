import { type SharedPermissions } from '@bad-crm/shared';

/**
 * Per-user exceptions of the current tenant.
 *
 * No method takes an `organizationId`: the tenant is the scope the caller opened, and a parameter
 * beside it is a second answer to the same question — one the policy filters silently rather than
 * refusing.
 */

export type OverrideEffect = 'ALLOW' | 'DENY';

export interface OverrideRow {
  readonly permissionKey: SharedPermissions.PermissionKey;
  readonly effect: OverrideEffect;
  readonly reason: string;
  readonly expiresAt: Date | null;
}

export interface OverrideDraftRow {
  readonly userId: string;
  readonly permissionKey: SharedPermissions.PermissionKey;
  readonly effect: OverrideEffect;
  readonly reason: string;
  readonly expiresAt: Date | null;
  readonly grantedById: string | null;
}

export interface PermissionOverrideRepositoryPort {
  /** Every exception of one person, expired ones included — the screen shows them until cleaned. */
  listFor(userId: string): Promise<readonly OverrideRow[]>;

  /** The current opinion about one key, or `null`. Read before writing, so the trail can say what changed. */
  find(userId: string, permissionKey: string): Promise<OverrideRow | null>;

  /**
   * One opinion per key: writes or replaces, never adds a second row.
   *
   * The uniqueness is in the schema (`uq_user_permission_overrides`), so «two different opinions
   * about the same right» is impossible rather than merely unusual.
   */
  upsert(draft: OverrideDraftRow): Promise<void>;

  /** `false` when there was nothing to remove — the same end state, and not an error. */
  remove(userId: string, permissionKey: string): Promise<boolean>;
}
