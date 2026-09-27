import { Badge, Button, NativeSelect, Table, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedLib } from '@shared';

import { type ProjectRosterRow } from '@units/project/lib';
import { PROJECT_ROLE_LABEL, PROJECT_ROLES, type ProjectRole } from '@units/project/model';

export interface ProjectMemberTableProps {
  readonly rows: readonly ProjectRosterRow[];
  /**
   * Present only for a reader the card's `permissions.canManageMembers` lets through — then each
   * row gets a role select and a remove button. Absent, the table is read-only: a control that
   * cannot work is not drawn (STORY-014-05, acceptance 5).
   */
  readonly onChangeRole?: (userId: string, projectRole: ProjectRole) => void;
  readonly onRemove?: (userId: string) => void;
  /** Archived: the controls stay on screen, disabled — the banner above says why (acceptance 7). */
  readonly locked?: boolean;
}

/**
 * Who is on the project, as what, and with how much of their time — and, for somebody who may
 * manage the roster, the two in-row commands.
 *
 * Every control carries the person's name in its accessible name: a column of identical «Role» and
 * «Remove» controls is, to a screen reader moving through them, a column of identical controls.
 */
export function ProjectMemberTable({
  rows,
  onChangeRole,
  onRemove,
  locked = false,
}: ProjectMemberTableProps) {
  const { t, i18n } = useTranslation();

  return (
    <Table>
      <Table.Thead>
        <Table.Tr>
          <Table.Th scope="col">{t('projects.team.column.person')}</Table.Th>
          <Table.Th scope="col">{t('projects.team.column.role')}</Table.Th>
          <Table.Th scope="col">{t('projects.team.column.allocation')}</Table.Th>
          {onRemove !== undefined && (
            <Table.Th scope="col">{t('projects.members.column.actions')}</Table.Th>
          )}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((row) => (
          <Table.Tr key={row.userId}>
            <Table.Td>
              <Text size="sm">{row.label}</Text>
            </Table.Td>
            <Table.Td>
              {onChangeRole === undefined ? (
                <Badge variant={row.projectRole === 'LEAD' ? 'filled' : 'light'}>
                  {t(PROJECT_ROLE_LABEL[row.projectRole])}
                </Badge>
              ) : (
                <NativeSelect
                  aria-label={t('projects.members.roleOf', { name: row.label })}
                  data={PROJECT_ROLES.map((value) => ({
                    value,
                    label: t(PROJECT_ROLE_LABEL[value]),
                  }))}
                  disabled={locked}
                  onChange={(event) => {
                    onChangeRole(row.userId, event.currentTarget.value as ProjectRole);
                  }}
                  value={row.projectRole}
                />
              )}
            </Table.Td>
            <Table.Td>
              <Text size="sm">
                {t('projects.team.allocation', {
                  percent: SharedLib.formatPercent(row.allocationPct, i18n.language),
                })}
              </Text>
            </Table.Td>
            {onRemove !== undefined && (
              <Table.Td>
                <Button
                  aria-label={t('projects.members.removeOf', { name: row.label })}
                  color="danger"
                  disabled={locked}
                  onClick={() => {
                    onRemove(row.userId);
                  }}
                  size="xs"
                  variant="subtle"
                >
                  {t('projects.members.remove')}
                </Button>
              </Table.Td>
            )}
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
