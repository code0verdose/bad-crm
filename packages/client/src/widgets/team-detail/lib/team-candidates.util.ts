import { type EmployeeApi } from '@units/employee';
import { type TeamApi } from '@units/team';

import { personLabel } from './person-label.util.js';

export interface TeamCandidate {
  readonly value: string;
  readonly label: string;
}

/**
 * Who can still be put on this team.
 *
 * Everybody the directory answered with, minus everybody already on it. Offering somebody who is
 * already a member is offering a request with no meaning: the endpoint is idempotent by constraint
 * and would answer «done» without doing anything, which is the interface teaching somebody that the
 * control does not work.
 *
 * A deactivated account never reaches this list, and not because of a filter here: the directory's
 * default audience is the live accounts, so a suspended person is not in the answer to begin with.
 * The screen still has to survive one being chosen — somebody can be switched off between the page
 * load and the click — and that is what `409 member_not_active` is for.
 */
export const teamCandidates = (
  people: readonly EmployeeApi.EmployeeListItem[],
  members: readonly TeamApi.TeamMember[],
): readonly TeamCandidate[] => {
  const onTheTeam = new Set(members.map((member) => member.userId));

  return people
    .filter((person) => !onTheTeam.has(person.userId))
    .map((person) => ({ value: person.userId, label: personLabel(person) }));
};
