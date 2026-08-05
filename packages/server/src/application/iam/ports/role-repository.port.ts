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
  provisionSystemRoles(drafts: readonly SystemRoleDraft[]): Promise<readonly RoleSummary[]>;

  /** Every role of the current organization, system and custom alike. */
  listRoles(): Promise<readonly RoleSummary[]>;
}
