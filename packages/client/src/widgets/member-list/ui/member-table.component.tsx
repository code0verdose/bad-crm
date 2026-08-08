import { Badge, Group, Table, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { type EmployeeApi } from '@units/employee';

import classes from './member-list-ui.module.css';

export interface MemberTableProps {
  readonly items: readonly EmployeeApi.EmployeeListItem[];
}

/**
 * Deactivated is marked by a word as well as by a colour (WCAG 1.4.1).
 *
 * A total map over the union rather than a lookup with a fallback: the contract closes the set, so a
 * fallback would be a branch no test can reach honestly — and the day the server adds a status, this
 * stops compiling instead of quietly rendering «Active» at a person who is not.
 */
const STATUS_KEYS: Record<EmployeeApi.EmployeeListItem['status'], string> = {
  ACTIVE: 'members.status.ACTIVE',
  SUSPENDED: 'members.status.SUSPENDED',
  INVITED: 'members.status.INVITED',
};

/**
 * The directory as rows.
 *
 * **Presentational**: it is handed the page and renders it. What it does not do is decide what a row
 * contains — the four employment columns are absent from a document a caller may not see them in, so
 * there is nothing here to hide.
 *
 * A person with no personnel record yet — an invitation accepted this morning — has no name to show,
 * and the e-mail carries the line instead of an empty cell that reads as a defect.
 */
export function MemberTable({ items }: MemberTableProps) {
  const { t } = useTranslation();

  return (
    <Table highlightOnHover striped>
      <Table.Thead>
        <Table.Tr>
          <Table.Th scope="col">{t('members.column.person')}</Table.Th>
          <Table.Th scope="col">{t('members.column.jobTitle')}</Table.Th>
          <Table.Th scope="col">{t('members.column.department')}</Table.Th>
          <Table.Th scope="col">{t('members.column.roles')}</Table.Th>
          <Table.Th scope="col">{t('members.column.teams')}</Table.Th>
          <Table.Th scope="col">{t('members.column.status')}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {items.map((item) => (
          <Table.Tr key={item.userId}>
            <Table.Td>
              {/* TanStack's own `Link`, not `Anchor component={Link}`: the polymorphic wrapper
                  widens the router to `AnyRouter` and takes the typed `params` with it, so a link to
                  a route that does not exist would compile. The styling is one class instead. */}
              <Link
                className={classes['personLink']}
                params={{ userId: item.userId }}
                to="/admin/members/$userId"
              >
                {nameOf(item)}
              </Link>
              <Text c="var(--bc-text-muted)" size="sm">
                {item.email}
              </Text>
            </Table.Td>
            <Table.Td>{item.jobTitle ?? '—'}</Table.Td>
            <Table.Td>{item.department ?? '—'}</Table.Td>
            <Table.Td>
              <Group gap="xs" wrap="wrap">
                {item.roles.map((role) => (
                  <Badge key={role.id} size="sm" variant="light">
                    {role.name}
                  </Badge>
                ))}
              </Group>
            </Table.Td>
            <Table.Td>
              <Group gap="xs" wrap="wrap">
                {item.teams.map((team) => (
                  <Badge key={team.id} size="sm" variant="outline">
                    {team.name}
                  </Badge>
                ))}
              </Group>
            </Table.Td>
            <Table.Td>
              <Badge
                color={item.status === 'SUSPENDED' ? 'gray' : 'green'}
                size="sm"
                variant="light"
              >
                {t(STATUS_KEYS[item.status])}
              </Badge>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/** The e-mail stands in for a name nobody has filled in yet — never a blank cell. */
const nameOf = (item: EmployeeApi.EmployeeListItem): string => {
  const name = `${item.firstName} ${item.lastName}`.trim();

  return name === '' ? item.email : name;
};
