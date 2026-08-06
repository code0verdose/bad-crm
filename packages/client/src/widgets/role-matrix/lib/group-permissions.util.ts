import { SharedPermissions } from '@bad-crm/shared';

import { type IamApi } from '@units/iam';

export interface PermissionGroup {
  readonly domain: SharedPermissions.PermissionDomain;
  readonly permissions: readonly SharedPermissions.PermissionKey[];
}

export interface GroupPermissionsInput {
  readonly roles: readonly IamApi.RoleListEntry[];
  readonly search: string;
  readonly onlyDifferences: boolean;
  readonly grants: (roleId: string, permission: string) => boolean;
}

/**
 * The rows of the matrix: the catalogue, filtered and grouped by domain.
 *
 * Outside the component on purpose (`rules/naming-and-structure.mdc` §E): this is the only real
 * computation on the screen, it is a pure function of its inputs, and a component that did it inline
 * would be a component nobody can test without a DOM.
 *
 * **«Only differences» compares the draft, not the server.** The point of the filter is to read what
 * distinguishes the roles right now, including the distinctions the person has just introduced —
 * a filter that answered from the last fetch would hide their own work.
 */
export const groupPermissions = ({
  roles,
  search,
  onlyDifferences,
  grants,
}: GroupPermissionsInput): readonly PermissionGroup[] => {
  const needle = search.toLowerCase();

  const matching = SharedPermissions.PERMISSIONS.filter((permission) => {
    if (needle !== '' && !permission.toLowerCase().includes(needle)) return false;

    const [reference] = roles;

    if (!onlyDifferences || reference === undefined) return true;

    const granted = grants(reference.id, permission);

    return roles.some((role) => grants(role.id, permission) !== granted);
  });

  return SharedPermissions.PERMISSION_DOMAINS.map((domain) => ({
    domain,
    permissions: matching.filter(
      (permission) => SharedPermissions.PERMISSION_META[permission].domain === domain,
    ),
  })).filter((group) => group.permissions.length > 0);
};
