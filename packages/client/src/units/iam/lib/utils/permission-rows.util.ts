import { SharedPermissions } from '@bad-crm/shared';

import {
  type HeldRoleFacts,
  type PermissionRow,
  type PermissionRowGroup,
  type PermissionStateFacts,
} from '@units/iam/types';

export interface PermissionRowsInput {
  readonly permissions: readonly PermissionStateFacts[];
  readonly roles: readonly HeldRoleFacts[];
  /** Substring matched against the key, lower-cased by the caller or not — handled here. */
  readonly search: string;
  /** Keep only the keys carrying a personal exception. */
  readonly exceptionsOnly: boolean;
}

/**
 * The table, assembled: the server's answer narrowed by the two filters and grouped by domain.
 *
 * Outside any component on purpose (`rules/naming-and-structure.mdc` §8): this is the only real
 * computation on the screen, it is a pure function of its inputs, and a component that did it
 * inline could not be tested without a DOM.
 *
 * **Nothing here decides anything about permissions.** `source` is copied through, never recomputed
 * — the ladder lives once, in `capabilityOutcome`, and the server has already walked it
 * (`permission-model.md` §«Слой 5»). What this function does is order, filter and name: the
 * catalogue's own order for the rows, the domain grouping the roles matrix already uses, and
 * `roleIds` turned into role names using the `roles` of the same response.
 *
 * A key the server reports and this build does not know is **dropped**, not rendered: the screen
 * offers a control that writes that key back, and a key outside the catalogue is one the endpoint
 * refuses with a 422 (`PermissionKey` parameter). Offering it would be offering an action that
 * cannot succeed. The reverse — a key this build knows and the server did not report — cannot
 * happen by contract, and would simply not appear.
 */
export const permissionRows = ({
  permissions,
  roles,
  search,
  exceptionsOnly,
}: PermissionRowsInput): readonly PermissionRowGroup[] => {
  const needle = search.trim().toLowerCase();
  const roleNames = new Map(roles.map((role) => [role.roleId, role.name]));
  const byKey = new Map(permissions.map((state) => [state.key, state]));

  const rows: readonly PermissionRow[] = SharedPermissions.PERMISSIONS.flatMap((key) => {
    const state = byKey.get(key);

    if (state === undefined) return [];
    if (needle !== '' && !key.toLowerCase().includes(needle)) return [];
    if (exceptionsOnly && state.override === null) return [];

    return [
      {
        key,
        source: state.source,
        override: state.override,
        // `roleIds` is reported under a DENY as well, which is what lets the control say what
        // lifting the exception would restore — an empty list means «inherits nothing».
        inheritedFrom: state.roleIds.flatMap((roleId) => {
          const name = roleNames.get(roleId);

          return name === undefined ? [] : [name];
        }),
        dangerous: SharedPermissions.PERMISSION_META[key].dangerous,
      },
    ];
  });

  return SharedPermissions.PERMISSION_DOMAINS.map((domain) => ({
    domain,
    rows: rows.filter((row) => SharedPermissions.PERMISSION_META[row.key].domain === domain),
  })).filter((group) => group.rows.length > 0);
};
