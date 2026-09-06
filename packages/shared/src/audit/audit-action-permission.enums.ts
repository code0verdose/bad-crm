import { PERMISSION_META, type PermissionKey } from '../permissions/permissions.catalog.js';
import { type AuditAction } from './audit-action.enums.js';

/**
 * Which permission keys an action stands behind: the capability a caller had to hold for the
 * use-case that files it to run at all.
 *
 * The trail and the permission catalogue name the same events from two sides — one says what
 * *happened*, the other what somebody had to be *allowed* — and until 2026-09-06 nothing joined
 * them. The join is needed the moment a decision about an entry depends on the right behind it,
 * and the first such decision is whether the action may take effect without its row
 * (`isDegradableAuditAction`, server side): a severity of `INFO` says the entry is quiet, and a
 * `dangerous` flag on the key says the read or write it records is one nobody must be able to do
 * unobserved. `permission.inspected` is both — an `INFO` entry behind `permission:override_read`,
 * a key the catalogue marks dangerous because «a read nobody is told about is how the write gets
 * planned» — and a rule that looked at severity alone let that read succeed with no row on the
 * day the insert failed.
 *
 * **A list, not one key.** `role.dangerous_granted` is filed by a composition that ran under
 * `role:create` or `role:update`, and an entry with two possible keys is honest about both rather
 * than picking one. Most entries have exactly one; the empty list is for actions no permission
 * gates: self-service on the caller's own account (`password.changed`, every `user.mfa_*` except
 * the administrator reset), events with no caller at all (`organization.registered`,
 * `rls.bypassed`), and the two refusal entries, whose key travels in the payload because it is
 * whichever one was refused.
 *
 * `Record<AuditAction, …>` for the reason `AUDIT_ACTION_SEVERITY` is one: an action added to the
 * catalogue with no row here does not compile, so the join cannot silently miss the newest entry.
 * The keys are checked against the permission catalogue by the type, and the rows against the
 * policies that actually check them by `test/audit/audit-action-permission.test.ts`.
 */
export const AUDIT_ACTION_PERMISSIONS: Readonly<Record<AuditAction, readonly PermissionKey[]>> = {
  // No account exists yet when this is filed.
  'organization.registered': [],
  // A credential, not a permission, opens a session.
  'session.signed_in': [],
  // `session-owner.policy.ts`: only the owner of a session may end it; no key is involved.
  'session.revoked': [],
  'session.refresh_reuse_detected': [],
  'password.changed': [],
  'password.reset': [],
  'user.mfa_enabled': [],
  'user.mfa_setup_failed': [],
  'user.mfa_recovery_code_used': [],
  'user.mfa_recovery_locked_out': [],
  'user.mfa_recovery_codes_regenerated': [],
  'user.mfa_disabled': [],
  'user.mfa_reset_by_admin': ['user:reset_mfa'],
  'role.created': ['role:create'],
  'role.updated': ['role:update'],
  'role.deleted': ['role:delete'],
  // Filed beside `role.created`/`role.updated` by the same composition, under whichever of the two
  // keys that composition ran.
  'role.dangerous_granted': ['role:create', 'role:update'],
  'role.assigned': ['role:assign'],
  'role.revoked': ['role:revoke'],
  'invitation.created': ['invitation:create'],
  'invitation.resent': ['invitation:resend'],
  'invitation.revoked': ['invitation:revoke'],
  // The invitee holds the token, not a permission: there is no account to hold one yet.
  'invitation.accepted': [],
  'employee.updated': ['employee:update'],
  'organization.security_policy_updated': ['organization:manage_security_policy'],
  'organization.ownership_transferred': ['organization:transfer_ownership'],
  'user.suspended': ['user:suspend'],
  'user.reactivated': ['user:reactivate'],
  'team.created': ['team:create'],
  'team.updated': ['team:update'],
  'team.deleted': ['team:delete'],
  // One key for all three membership entries: there is one endpoint, and the lead is a column of
  // the membership row, not a right of its own (`team.member_role_changed`'s own entry).
  'team.member_added': ['team:manage_members'],
  'team.member_removed': ['team:manage_members'],
  'team.member_role_changed': ['team:manage_members'],
  'permission.override.created': ['permission:override'],
  'permission.override.updated': ['permission:override'],
  'permission.override.deleted': ['permission:override'],
  'acl.granted': ['acl:grant'],
  'acl.revoked': ['acl:revoke'],
  // A capability of the process, not of a person; nothing in the catalogue grants it.
  'rls.bypassed': [],
  'permission.inspected': ['permission:override_read'],
  // The refused key is in `after`; it is whichever one the caller lacked.
  'access.denied': [],
  'access.denial_burst': [],
};

/** The keys an action stands behind, for a caller that has a validated action and nothing else. */
export const permissionsBehind = (action: AuditAction): readonly PermissionKey[] =>
  AUDIT_ACTION_PERMISSIONS[action];

/**
 * Whether any key behind the action is one the catalogue marks `dangerous`.
 *
 * `some`, not `every`: an entry that *may* have run under a dangerous key is one whose absence from
 * the trail would hide the exercise of that key, and the rule that reads this exists to keep such
 * entries from going missing.
 */
export const isBehindDangerousPermission = (action: AuditAction): boolean =>
  AUDIT_ACTION_PERMISSIONS[action].some((key) => PERMISSION_META[key].dangerous);
