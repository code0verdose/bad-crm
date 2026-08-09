import { type EmployeeApi } from '@units/employee';
import { type TeamApi } from '@units/team';

import { personLabel } from './person-label.util.js';

export interface RosterRow {
  readonly userId: string;
  readonly teamRole: TeamApi.TeamMember['teamRole'];
  readonly joinedAt: string;
  /**
   * What to show for this account: a name when the directory answered with one, otherwise the id.
   *
   * Never empty. A blank cell reads as a membership that lost its owner, and the id is what the
   * contract actually gives — `GET /teams/{teamId}` carries user ids and no names, because names are
   * `user:read` and attaching a second permission's worth of personal data to a read that asked
   * which accounts are on a team would be the wrong trade.
   */
  readonly label: string;
}

/**
 * The roster, joined with whatever the directory could say about the people on it.
 *
 * Two callers cannot supply that, and both land on the same fallback — which is why it is one rule
 * here rather than two conditions in the table: somebody without `user:read`, for whom the screen
 * never asks, and a roster with somebody outside the page of the directory it did fetch.
 */
export const rosterRows = (
  members: readonly TeamApi.TeamMember[],
  people: readonly EmployeeApi.EmployeeListItem[],
): readonly RosterRow[] => {
  const named = new Map(people.map((person) => [person.userId, personLabel(person)]));

  return members.map((member) => ({
    userId: member.userId,
    teamRole: member.teamRole,
    joinedAt: member.joinedAt,
    label: named.get(member.userId) ?? member.userId,
  }));
};
