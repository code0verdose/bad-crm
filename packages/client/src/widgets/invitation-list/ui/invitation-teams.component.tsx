import { Badge, Group, Text } from '@mantine/core';

import { TeamService } from '@units/team';

export interface InvitationTeamsProps {
  readonly teamIds: readonly string[];
}

/**
 * The teams an invitation carries, by name.
 *
 * **Mounted only for a reader who holds `team:read`** — which is how the request stays behind the
 * permission. The two other names on this screen are asked for with `enabled` on their unit query;
 * `useTeamListQuery()` offers no such option, and adding one would mean editing a unit this screen
 * has no business editing. Not rendering the cell has exactly the same effect: no component, no
 * hook, no request certain to be refused.
 *
 * A team the answer does not carry falls back to nothing rather than to its identifier, by the same
 * rule as the role and the inviter: a UUID in a table cell is noise a person has to ignore.
 */
export function InvitationTeams({ teamIds }: InvitationTeamsProps) {
  const teams = TeamService.TeamQueries.useTeamListQuery();
  const names = new Map((teams.data ?? []).map((team) => [team.id, team.name]));
  const known = teamIds.flatMap((id) => {
    const name = names.get(id);

    return name === undefined ? [] : [{ id, name }];
  });

  if (known.length === 0) return <Text>—</Text>;

  return (
    <Group gap="xs" wrap="wrap">
      {known.map((team) => (
        <Badge key={team.id} size="sm" variant="outline">
          {team.name}
        </Badge>
      ))}
    </Group>
  );
}
