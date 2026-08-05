import { type SharedPermissions } from '@bad-crm/shared';
import { type ErrorCode, type ErrorResource } from '@bad-crm/shared/errors';

import { AppError, type ErrorDetails } from '@/domain/shared/errors/app.errors.js';

/**
 * A refusal from the permission layer, carrying the reason into the response.
 *
 * One class rather than six subclasses of the existing error families, because the reason is the
 * only thing they would add and the status already follows from the code. It is a first-class
 * property for the same reason `ValidationError.issues` is: `details` never reaches the body by
 * design (it is developer context for the log), and this value is meant for the client — the screen
 * that explains a denial and the audit filter both read it.
 */
export class AccessRefusedError extends AppError {
  readonly reason: SharedPermissions.DenyReason;

  constructor(code: ErrorCode, reason: SharedPermissions.DenyReason, details?: ErrorDetails) {
    super(code, `Access refused: ${reason}`, details);

    this.reason = reason;
  }
}

/**
 * Which code answers which refusal — the whole mapping, in one exhaustive table.
 *
 * `Record<DenyReason, …>` rather than a `switch` with a default: a reason added to the catalogue
 * without an answer here is a compile error, and the default branch it replaces is exactly how a new
 * refusal ends up answered 403 «because that is what the fallback did».
 *
 * Three groups, and the grouping is the model:
 *
 * - **Per-resource codes** (`role_forbidden`, `role_not_found`) — the refusal is about an object, and
 *   the client translates it per resource. Note that `resource_not_found` and `tenant_mismatch` both
 *   answer 404: from outside, «not yours» and «not there» must be one answer (invariant 2).
 * - **Installation- and session-wide codes** (`service_unavailable`, `vault_locked`) — they describe
 *   the deployment or the session, so naming a resource in them would invent codes that mean nothing.
 * - **Conflicts** (409) — the caller may do this, the object exists, and the current state refuses:
 *   the last owner, a closed period, a system role, one's own last way in.
 */
const CODE_FOR: Readonly<
  Record<SharedPermissions.DenyReason, (resource: ErrorResource) => ErrorCode>
> = {
  not_authenticated: () => 'unauthenticated',
  unknown_permission: (resource) => `${resource}_forbidden`,
  permission_not_granted: (resource) => `${resource}_forbidden`,
  denied_by_override: (resource) => `${resource}_forbidden`,
  resource_required: (resource) => `${resource}_forbidden`,
  resource_not_found: (resource) => `${resource}_not_found`,
  acl_explicit_none: (resource) => `${resource}_forbidden`,
  insufficient_acl_level: (resource) => `${resource}_forbidden`,
  acl_resolution_failed: () => 'service_unavailable',
  tenant_mismatch: (resource) => `${resource}_not_found`,
  vault_locked: () => 'vault_locked',
  period_locked: () => 'period_locked',
  last_owner_required: () => 'last_owner_required',
  self_lockout: () => 'self_lockout',
  system_role_immutable: () => 'system_role_immutable',
};

/**
 * The error a refusal becomes, decided in one place.
 *
 * Call sites state *why* they refused and *what* they refused access to; they never choose a status.
 * That is what keeps the 403-versus-404 rule a property of the code instead of a paragraph everybody
 * has to remember — the same design as `access-denial.util.ts`, which this generalises from
 * ownership checks to the full permission model.
 */
export const accessErrorFor = (
  reason: SharedPermissions.DenyReason,
  resource: ErrorResource,
  details?: ErrorDetails,
): AccessRefusedError => new AccessRefusedError(CODE_FOR[reason](resource), reason, details);
