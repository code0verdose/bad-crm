import { ActionIcon, Badge, Table, Text } from '@mantine/core';
import { IconUserMinus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

import { SharedLib } from '@shared';

// `@widgets/team-detail/lib` is the segment's barrel, not a path inside it and not a `../`: the
// widget's own `lib` is reachable by alias exactly the way `@shared/lib` is (`rules/frontend-fsd.mdc`
// rules 2–3).
import { type RosterRow } from '@widgets/team-detail/lib';
import { TeamModel } from '@units/team';

export interface TeamMemberTableProps {
  readonly rows: readonly RosterRow[];
  /**
   * Absent when nobody may change the composition — not a disabled column, and not a column of
   * buttons that answer 403. A control that cannot work is not drawn (`ux-architecture.md`, принцип 6).
   */
  readonly onRemove?: (userId: string) => void;
  readonly removingUserId?: string;
}

/**
 * Who is on the team.
 *
 * **The role is a badge with a word in it**, not a colour: `LEAD` and `MEMBER` differ by text and by
 * variant, because colour is never the only carrier of meaning (`rules/a11y.mdc` §2). There is no
 * `leadId` anywhere — a lead is a membership that says so, and this column is where that shows.
 *
 * **Each remove control names the person it would remove.** Every row carries the same icon, so a
 * shared label leaves a screen reader hearing «remove, remove, remove» with no way to tell which row
 * it is on (`rules/a11y.mdc` §17).
 */
export function TeamMemberTable({ rows, onRemove, removingUserId }: TeamMemberTableProps) {
  const { t, i18n } = useTranslation();

  return (
    <Table highlightOnHover>
      <Table.Thead>
        <Table.Tr>
          <Table.Th scope="col">{t('teams.members.column.person')}</Table.Th>
          <Table.Th scope="col">{t('teams.members.column.role')}</Table.Th>
          <Table.Th scope="col">{t('teams.members.column.joined')}</Table.Th>
          {onRemove !== undefined && (
            <Table.Th scope="col">{t('teams.members.column.actions')}</Table.Th>
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
              <Badge variant={row.teamRole === 'LEAD' ? 'filled' : 'light'}>
                {t(TeamModel.TEAM_ROLE_LABEL[row.teamRole])}
              </Badge>
            </Table.Td>
            <Table.Td>
              <Text size="sm">
                {SharedLib.formatDate(row.joinedAt, i18n.language, SharedLib.resolveTimeZone())}
              </Text>
            </Table.Td>
            {onRemove !== undefined && (
              <Table.Td>
                <ActionIcon
                  aria-label={t('teams.members.remove', { person: row.label })}
                  color="red"
                  loading={removingUserId === row.userId}
                  onClick={() => {
                    onRemove(row.userId);
                  }}
                  variant="subtle"
                >
                  <IconUserMinus size={20} stroke={1.5} />
                </ActionIcon>
              </Table.Td>
            )}
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
