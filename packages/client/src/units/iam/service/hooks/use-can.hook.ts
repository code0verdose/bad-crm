import { useMemo } from 'react';
import { SharedPermissions } from '@bad-crm/shared';

import { useMyPermissionsQuery } from '@units/iam/service/queries';

export interface CanController {
  /**
   * Whether the interface should offer this action.
   *
   * `false` while the permissions are still loading, and that is the fail-closed direction: a button
   * that appears late is a small annoyance, one that appears and then vanishes is a person clicking
   * something that disappears under the cursor.
   */
  readonly can: (permission: string, accessLevel?: SharedPermissions.AccessLevel) => boolean;
  /**
   * Layers 1–3 alone: does this person **hold** the capability, leaving any resource out of it.
   *
   * The question a route gate asks, and the reason it is a separate member rather than a default of
   * `can`. A permission whose catalogue entry names a `requiredLevel` is refused by `can()` unless an
   * ACL level is supplied, which is correct for a control acting on one object — and wrong for a
   * screen that has no object at all. `organization:manage_security_policy` is the first such key a
   * route was gated on, and `can()` hid the whole section from its owner: the server gates that
   * route with `authorizeCapability` (`require-permission.middleware.ts`), the organization is not a
   * resource with an ACL row, and nothing on the client could resolve a level for it anyway.
   *
   * So this member mirrors the route gate, `can` keeps mirroring the object-level decision, and
   * neither has to guess which one a caller meant.
   */
  readonly holds: (permission: string) => boolean;
  readonly isLoading: boolean;
}

/**
 * The client half of the permission model — **hints only**.
 *
 * It calls the same `can()` from `@bad-crm/shared` the server calls, which is the point: one
 * implementation, one set of table-driven tests, no second opinion about what a permission means. A
 * client that reimplemented the algorithm would drift, and the drift would show as a button that
 * works for some people and 403s for others.
 *
 * What it must never become is an authorisation: every request the offered button makes is checked
 * again on the server, and a stale copy costs a refused action rather than an unauthorised one
 * (`docs/architecture/ux-architecture.md`, «Клиентская проверка — только подсказка»).
 */
export const useCan = (): CanController => {
  const query = useMyPermissionsQuery();
  const view = useMemo<SharedPermissions.CapabilityView | undefined>(
    () =>
      query.data === undefined
        ? undefined
        : {
            isOwner: query.data.isOwner,
            permissions: new Set(
              query.data.permissions.filter((key): key is SharedPermissions.PermissionKey =>
                SharedPermissions.isPermissionKey(key),
              ),
            ),
            denied: new Set(
              query.data.denied.filter((key): key is SharedPermissions.PermissionKey =>
                SharedPermissions.isPermissionKey(key),
              ),
            ),
          },
    [query.data],
  );

  return {
    // Fail-closed while loading: `view` is `undefined` until the caller's own capabilities have
    // arrived, and offering a button before the answer exists is the "appears, then vanishes"
    // annoyance the docstring above rules out.
    can: (permission, accessLevel) =>
      view !== undefined && SharedPermissions.can(view, permission, accessLevel),
    holds: (permission) =>
      view !== undefined &&
      SharedPermissions.isPermissionKey(permission) &&
      SharedPermissions.effectivePermission(view, permission),
    isLoading: query.isPending,
  };
};
