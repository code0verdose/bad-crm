import { Badge, Button, Group, Table, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedLib, SharedUi } from '@shared';

import { type AuthApi } from '@units/auth';

/** What the contract sends when the deployment gave it no address it could read. */
const NO_ADDRESS = 'unknown';

export interface SessionTableProps {
  readonly sessions: readonly AuthApi.SessionSummary[];
  /** The moment «last active» is measured from. A parameter so a test can state one. */
  readonly now: Date;
  /** Asked about one row. The widget decides whether that is a revocation or a sign-out. */
  readonly onClose: (session: AuthApi.SessionSummary) => void;
}

/**
 * The devices holding a live session, in the order the server sent them.
 *
 * **Presentational**: handed the rows, renders them. It sorts nothing and hides nothing — including
 * the current session, which is the row somebody needs to see in order to tell it apart from the
 * others.
 *
 * **«This device» is a word, not a highlighted row** (`rules/a11y.mdc` §2). It is also the reason
 * the action on that row reads «Sign out»: the operation is the same one, and calling it «close»
 * beside four other «close» buttons is how somebody ends their own session while trying to end
 * another.
 *
 * **The address is the masked one, and it is the only one there is.** The full address is not stored
 * anywhere — `Session.ipHash` cannot be un-hashed and `ipMasked` had its host part removed before the
 * row was written — so there is nothing here to leak and nothing to reveal on hover. `unknown` is a
 * value the contract states rather than an absent field, and it is rendered as a sentence: a
 * deployment behind a socket has no address to show, and the literal word «unknown» in an English
 * table is not a translation.
 *
 * **«Last active» is relative, with the exact moment one hover away** — the granularity is the
 * fifteen-minute rotation, so a precise timestamp would claim more than the data carries.
 */
export function SessionTable({ sessions, now, onClose }: SessionTableProps) {
  const { t, i18n } = useTranslation();
  const zone = SharedLib.resolveTimeZone();

  return (
    <Table highlightOnHover striped>
      <Table.Thead>
        <Table.Tr>
          <Table.Th scope="col">{t('security.sessions.column.device')}</Table.Th>
          <Table.Th scope="col">{t('security.sessions.column.address')}</Table.Th>
          <Table.Th scope="col">{t('security.sessions.column.started')}</Table.Th>
          <Table.Th scope="col">{t('security.sessions.column.lastUsed')}</Table.Th>
          <Table.Th scope="col">{t('security.sessions.column.actions')}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {sessions.map((session) => (
          <Table.Tr key={session.id}>
            <Table.Td>
              <Group gap="xs" wrap="nowrap">
                <Text size="sm">{session.device}</Text>
                {session.current && (
                  <Badge color="success" size="sm" variant="light">
                    {t('security.sessions.current')}
                  </Badge>
                )}
              </Group>
            </Table.Td>
            <Table.Td>
              <Text size="sm">
                {session.ipMasked === NO_ADDRESS
                  ? t('security.sessions.unknownAddress')
                  : session.ipMasked}
              </Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm">{SharedLib.formatDate(session.createdAt, i18n.language, zone)}</Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm">
                <SharedUi.RelativeTime iso={session.lastUsedAt} now={now} />
              </Text>
            </Table.Td>
            <Table.Td>
              <Button
                aria-label={
                  session.current
                    ? t('security.sessions.action.signOutAria')
                    : t('security.sessions.action.revokeAria', { device: session.device })
                }
                color="danger"
                onClick={() => {
                  onClose(session);
                }}
                size="compact-sm"
                variant="subtle"
              >
                {session.current
                  ? t('security.sessions.action.signOut')
                  : t('security.sessions.action.revoke')}
              </Button>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
