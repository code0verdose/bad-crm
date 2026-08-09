import { Table, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { type TeamApi } from '@units/team';

import classes from './team-list-ui.module.css';

export interface TeamTableProps {
  readonly items: readonly TeamApi.TeamListEntry[];
}

/**
 * The org structure as rows: what the team is called, where it lives, and how many people are on it.
 *
 * **The count and not the people.** `GET /teams` answers with `memberCount` on purpose — a list
 * screen asks «how big is this team» before it opens one, and shipping every roster in the
 * organization to answer that would be paying for the second question to answer the first. Who they
 * are is one link away.
 *
 * The name is the link rather than a separate «open» control: a row whose only affordance is a
 * button at the end of it is a row a keyboard user tabs across to reach.
 */
export function TeamTable({ items }: TeamTableProps) {
  const { t } = useTranslation();

  return (
    <Table highlightOnHover striped>
      <Table.Thead>
        <Table.Tr>
          <Table.Th scope="col">{t('teams.column.name')}</Table.Th>
          <Table.Th scope="col">{t('teams.column.slug')}</Table.Th>
          <Table.Th scope="col">{t('teams.column.members')}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {items.map((team) => (
          <Table.Tr key={team.id}>
            <Table.Td>
              {/* TanStack's own `Link`, not `Anchor component={Link}`: the polymorphic wrapper
                  widens the router to `AnyRouter` and takes the typed `params` with it, so a link to
                  a route that does not exist would compile. The styling is one class instead. */}
              <Link
                className={classes['teamLink']}
                params={{ teamId: team.id }}
                to="/admin/teams/$teamId"
              >
                {team.name}
              </Link>
              {team.description !== null && (
                <Text c="var(--bc-text-muted)" size="sm">
                  {team.description}
                </Text>
              )}
            </Table.Td>
            <Table.Td>
              <Text size="sm">{team.slug}</Text>
            </Table.Td>
            <Table.Td>{team.memberCount}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
