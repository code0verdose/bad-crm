/**
 * Why a permission check said no (layer 5 of the permission model).
 *
 * Source of truth: `docs/security/permission-model.md` §«Слой 5 — итоговое решение».
 *
 * Not decoration. The reason travels into `AuditLog`, into the `reason` member of the `problem+json`
 * response (an extension member, which RFC 9457 allows — **not** the `type` URI, which is derived
 * from the error code) and into the interface, where «you are missing permission X» and «you have no
 * access to this object» are different sentences with different remedies. A refusal without a reason
 * is a refusal that can only be debugged by reading the code — and 403s that look alike are how
 * support tickets become archaeology.
 *
 * Closed list, like every catalogue in this project: a reason invented at a call site is a reason
 * nobody translated and no filter over the trail can find.
 */
export const DENY_REASONS = [
  /** No session at all: the caller is anonymous where a subject is required. */
  'not_authenticated',
  /** The key is not in the catalogue — a typo, or a permission removed from the code. Fail-closed. */
  'unknown_permission',
  /** No role and no override grants it. */
  'permission_not_granted',
  /** A per-user DENY override beats every ALLOW below it (owners excepted). */
  'denied_by_override',
  /** The permission is resource-scoped and the check was made without a resource. */
  'resource_required',
  /** The resource does not exist, or belongs to another tenant — answered as 404, never 403. */
  'resource_not_found',
  /** An explicit `NONE` on the resource: silence would be inheritance, this is a refusal. */
  'acl_explicit_none',
  /** The level held is below the level the permission requires. */
  'insufficient_acl_level',
  /** The ACL could not be resolved (an unreachable reader, a broken chain) — fail-closed. */
  'acl_resolution_failed',
  /** The subject and the object belong to different organizations. */
  'tenant_mismatch',
  /** The vault is locked: no permission substitutes for a key the server does not have. */
  'vault_locked',
  /** The period is closed — approved time and invoiced work are not editable by permission. */
  'period_locked',
  /** The last owner cannot be stripped of ownership: the organization would be unadministrable. */
  'last_owner_required',
  /** The change would remove the actor's own access — refused, so nobody locks themselves out. */
  'self_lockout',
  /** System roles are code, not data: their permission set is not editable from the interface. */
  'system_role_immutable',
] as const;

export type DenyReason = (typeof DENY_REASONS)[number];

export const isDenyReason = (value: string): value is DenyReason =>
  (DENY_REASONS as readonly string[]).includes(value);
