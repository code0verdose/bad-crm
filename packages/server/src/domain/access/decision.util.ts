import { type SharedPermissions } from '@bad-crm/shared';
import { type ErrorResource } from '@bad-crm/shared/errors';

import { accessErrorFor } from '@/domain/access/access.errors.js';
import { type Decision } from '@/domain/access/decision.types.js';

export const allow = (): Decision => ({ allowed: true, reason: null });

export const deny = (reason: SharedPermissions.DenyReason): Decision => ({
  allowed: false,
  reason,
});

/**
 * Turns a refusal into the failure the HTTP layer answers with — and narrows the type.
 *
 * The assertion signature is what makes forgetting the check awkward: after `assertAllowed`, the
 * decision is `allowed: true` for the compiler, so code that skipped it and read the resource anyway
 * still has a `Decision` it has to deal with.
 *
 * `resource` is required because 403 and 404 are coded per resource in this project
 * (`role_forbidden`, `role_not_found`); there is no generic `forbidden` code, and inventing one
 * would leave the client with a message it cannot phrase.
 */
export function assertAllowed(
  decision: Decision,
  resource: ErrorResource,
): asserts decision is { allowed: true; reason: null } {
  if (!decision.allowed) throw accessErrorFor(decision.reason, resource);
}
