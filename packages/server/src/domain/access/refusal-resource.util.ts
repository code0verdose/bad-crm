import { SharedPermissions } from '@bad-crm/shared';
import { ERROR_RESOURCES, type ErrorResource } from '@bad-crm/shared/errors';

const KNOWN: ReadonlySet<string> = new Set<string>(ERROR_RESOURCES);

/**
 * Which resource a capability refusal is coded as — `role:assign` → `role_forbidden`.
 *
 * The two catalogues do not have the same shape and should not: `ERROR_RESOURCES` is the list of
 * things a client has a translated sentence for, while `PERMISSION_META[...].resource` names every
 * noun the product has a permission about, including several that never appear in an error body
 * (`mail`, `acl`, `job`). So the mapping is total by construction rather than by coincidence:
 *
 * - the permission's own resource, when the client can translate it. That is the useful case, and it
 *   is what makes «you may not manage roles» different from «you may not see invoices» on screen;
 * - **`organization` otherwise**, which is not a fallback in disguise but the literal truth about a
 *   capability check: it asks whether the caller may do this *anywhere in this organization*, with
 *   no object involved. A refusal at that layer is a refusal by the organization.
 *
 * `permission-guard.test.ts` walks the whole catalogue, so a key whose resource stops resolving is a
 * failing test rather than a runtime surprise.
 */
export const refusalResourceOf = (permission: SharedPermissions.PermissionKey): ErrorResource => {
  const resource = SharedPermissions.PERMISSION_META[permission].resource;

  return KNOWN.has(resource) ? (resource as ErrorResource) : 'organization';
};
