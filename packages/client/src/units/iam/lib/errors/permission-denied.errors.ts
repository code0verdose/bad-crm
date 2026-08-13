import { type SharedPermissions } from '@bad-crm/shared';

/**
 * The brand that survives what `instanceof` does not.
 *
 * Routes are code-split by design (`rules/frontend-fsd.mdc` rule 12), and a class travelling
 * between chunks is only ever *one* class as long as the bundler keeps one copy of this module.
 * That is true today and is not a property this file can guarantee for the boundary that reads the
 * refusal — the router's error component, which lives in another layer and another chunk. A brand
 * on the value is checked the way `@tanstack/react-router` checks its own signals (`isRedirect`,
 * `isNotFound`), and for the same reason: the answer must not depend on module identity.
 */
const PERMISSION_DENIED = 'permission-denied' as const;

/**
 * «You are signed in, this section exists, and you may not open it.»
 *
 * Thrown by `requirePermission` for a section whose existence is not a secret inside the
 * organization — `/admin/**`, `/reports/**`, `/delivery/**`, a colleague's profile
 * (`ux-architecture.md` → «403 vs 404»). It is a plain error rather than one of the router's own
 * signals precisely so that it lands in the route's `errorComponent`: `notFound()` would be taken
 * by `notFoundComponent`, which is the screen that must stay indistinguishable from «no such
 * address» for everything in the closed contour.
 *
 * It carries the permission because the screen's whole value is naming it: `role:read` is a key
 * from the closed catalogue, the exact string an administrator grants, and without it the refusal
 * is a shrug the reader can only escalate.
 */
export class PermissionDeniedError extends Error {
  readonly kind = PERMISSION_DENIED;

  readonly permission: SharedPermissions.PermissionKey;

  constructor(permission: SharedPermissions.PermissionKey) {
    // For the log and for a failing test, never for the screen: the sentence a person reads is
    // chosen from the catalogue by the component (`rules/errors-and-toasts.mdc` §10).
    super(`Permission denied: ${permission}`);

    this.name = 'PermissionDeniedError';
    this.permission = permission;
  }
}

export const isPermissionDenied = (value: unknown): value is PermissionDeniedError =>
  value instanceof Error &&
  (value as Partial<PermissionDeniedError>).kind === PERMISSION_DENIED &&
  typeof (value as Partial<PermissionDeniedError>).permission === 'string';
