import { Table, Text } from '@mantine/core';
import { memo } from 'react';
import { SharedPermissions } from '@bad-crm/shared';
import { useTranslation } from 'react-i18next';

import { IamModel, type IamApi } from '@units/iam';

import classes from './role-matrix-group.module.css';
import { RoleMatrixCell } from './role-matrix-cell.component.js';

export interface RoleMatrixGroupProps {
  readonly domain: SharedPermissions.PermissionDomain;
  readonly permissions: readonly SharedPermissions.PermissionKey[];
  readonly roles: readonly IamApi.RoleListEntry[];
  readonly collapsed: boolean;
  readonly grants: (roleId: string, permission: string) => boolean;
  readonly onToggle: (roleId: string, permission: string) => void;
  readonly onCollapse: (domain: SharedPermissions.PermissionDomain) => void;
}

/**
 * One domain of the catalogue as a block of rows.
 *
 * The group header is a real button inside a row that spans the table, so a keyboard reaches it in
 * document order and a screen reader announces «collapsed» rather than the reader having to infer it
 * from rows that stopped existing.
 */
function RoleMatrixGroupRows({
  domain,
  permissions,
  roles,
  collapsed,
  grants,
  onToggle,
  onCollapse,
}: RoleMatrixGroupProps) {
  const { t } = useTranslation();

  return (
    <>
      <Table.Tr>
        <Table.Th colSpan={roles.length + 1} scope="colgroup">
          <button
            type="button"
            onClick={() => {
              onCollapse(domain);
            }}
            aria-expanded={!collapsed}
          >
            {`${t(IamModel.PERMISSION_DOMAIN_LABEL_KEY[domain])} (${String(permissions.length)})`}
          </button>
        </Table.Th>
      </Table.Tr>

      {!collapsed &&
        permissions.map((permission) => (
          <Table.Tr key={permission}>
            <Table.Th className={classes['rowHeader']} scope="row">
              <Text component="span" size="sm">
                {permission}
              </Text>
              {SharedPermissions.PERMISSION_META[permission].dangerous && (
                <Text component="span" c="red" size="xs">
                  {` ${t('roles.dangerous')}`}
                </Text>
              )}
            </Table.Th>
            {roles.map((role) => (
              <Table.Td key={role.id}>
                <RoleMatrixCell
                  roleName={role.name}
                  permission={permission}
                  granted={grants(role.id, permission)}
                  locked={role.isSystem}
                  onToggle={() => {
                    onToggle(role.id, permission);
                  }}
                />
              </Table.Td>
            ))}
          </Table.Tr>
        ))}
    </>
  );
}

/**
 * Memoised, and the props are what make it work: `grants`, `onToggle` and `onCollapse` all come from
 * a `useCallback` above, so a collapsed group is skipped entirely on a keystroke and an expanded one
 * re-renders only because `grants` really did change. The domain travels as an argument rather than
 * closed over per group — an arrow built in the parent's render would give every group a new prop on
 * every render and make this `memo` decorative.
 */
export const RoleMatrixGroup = memo(RoleMatrixGroupRows);
