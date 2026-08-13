import { Badge, Button, Group, Stack, Table, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

import { SharedLib } from '@shared';

// `@widgets/invitation-list/lib` is the segment's barrel, not a path inside it and not a `../`.
import { type InvitationRow } from '@widgets/invitation-list/lib';

import { InvitationTeams } from './invitation-teams.component.js';

export interface InvitationTableProps {
  readonly rows: readonly InvitationRow[];
  /** Whether the teams cell is mounted at all — see `InvitationTeams` for why it is a mount. */
  readonly mayReadTeams: boolean;
  /**
   * Absent when the reader may not re-issue — not a disabled button, and not one that answers 403.
   * A control that cannot work is not drawn (`ux-architecture.md`, принцип 6).
   */
  readonly onResend?: (row: InvitationRow) => void;
  readonly onRevoke?: (row: InvitationRow) => void;
}

/**
 * The open invitations as rows, in the order the server sent them.
 *
 * **Presentational**: it is handed the rows and renders them. It sorts nothing, filters nothing and
 * hides nothing — an expired invitation stays on the list, because it is exactly the row somebody
 * came here to re-issue or close.
 *
 * **Expired is a word and an icon, not a colour** (`rules/a11y.mdc` §2), and it is computed against
 * the clock rather than read off the answer — the contract carries a date for that reason.
 *
 * **Each control names the address it acts on.** Every row has the same two buttons, so a shared
 * label leaves a screen reader hearing «re-issue, re-issue, re-issue» with no way to tell which row
 * it is on (§17).
 */
export function InvitationTable({ rows, mayReadTeams, onResend, onRevoke }: InvitationTableProps) {
  const { t, i18n } = useTranslation();
  const zone = SharedLib.resolveTimeZone();

  return (
    <Table highlightOnHover striped>
      <Table.Thead>
        <Table.Tr>
          <Table.Th scope="col">{t('members.invitations.column.person')}</Table.Th>
          <Table.Th scope="col">{t('members.invitations.column.role')}</Table.Th>
          <Table.Th scope="col">{t('members.invitations.column.teams')}</Table.Th>
          <Table.Th scope="col">{t('members.invitations.column.invitedBy')}</Table.Th>
          <Table.Th scope="col">{t('members.invitations.column.created')}</Table.Th>
          <Table.Th scope="col">{t('members.invitations.column.expires')}</Table.Th>
          {(onResend !== undefined || onRevoke !== undefined) && (
            <Table.Th scope="col">{t('members.invitations.column.actions')}</Table.Th>
          )}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((row) => (
          <Table.Tr key={row.id}>
            <Table.Td>{row.email}</Table.Td>
            <Table.Td>{row.roleLabel ?? '—'}</Table.Td>
            <Table.Td>
              {mayReadTeams ? <InvitationTeams teamIds={row.teamIds} /> : <Text>—</Text>}
            </Table.Td>
            <Table.Td>{row.invitedByLabel ?? '—'}</Table.Td>
            <Table.Td>{SharedLib.formatDate(row.createdAt, i18n.language, zone)}</Table.Td>
            <Table.Td>
              <Stack gap={4}>
                <Text size="sm">{SharedLib.formatDate(row.expiresAt, i18n.language, zone)}</Text>
                {row.isExpired && (
                  <Badge
                    color="warning"
                    leftSection={<IconAlertTriangle size={16} stroke={1.5} />}
                    size="sm"
                    variant="light"
                  >
                    {t('members.invitations.expired')}
                  </Badge>
                )}
              </Stack>
            </Table.Td>
            {(onResend !== undefined || onRevoke !== undefined) && (
              <Table.Td>
                <Group gap="xs" wrap="nowrap">
                  {onResend !== undefined && (
                    <Button
                      aria-label={t('members.invitations.action.resendAria', { email: row.email })}
                      onClick={() => {
                        onResend(row);
                      }}
                      size="compact-sm"
                      variant="light"
                    >
                      {t('members.invitations.action.resend')}
                    </Button>
                  )}
                  {onRevoke !== undefined && (
                    <Button
                      aria-label={t('members.invitations.action.revokeAria', { email: row.email })}
                      color="danger"
                      onClick={() => {
                        onRevoke(row);
                      }}
                      size="compact-sm"
                      variant="subtle"
                    >
                      {t('members.invitations.action.revoke')}
                    </Button>
                  )}
                </Group>
              </Table.Td>
            )}
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
