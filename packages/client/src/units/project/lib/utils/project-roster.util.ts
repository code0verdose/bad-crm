import { SharedLib } from '@shared';

import { type ProjectRole } from '@units/project/model';
import { type PersonName } from '@units/project/types';

/** The fields of a membership the roster reads — structural, see `types/project.types.ts`. */
export interface RosterMembership {
  readonly userId: string;
  readonly projectRole: ProjectRole;
  readonly allocationPct: number;
}

export interface ProjectRosterRow extends RosterMembership {
  /** The person's name when the reader may see the directory, their id otherwise (`nameOf`). */
  readonly label: string;
}

/**
 * The roster joined with the directory. The lead goes first; the rest keep the joining order the
 * server sent (`Array.prototype.sort` is stable). One lookup table for the whole roster rather
 * than a search per row.
 */
export const projectRoster = (
  memberships: readonly RosterMembership[],
  people: readonly PersonName[],
): readonly ProjectRosterRow[] => {
  const named = new Map(
    people.map((person) => [person.userId, SharedLib.personLabel(person, person.email)]),
  );

  return memberships
    .map((membership) => ({
      userId: membership.userId,
      projectRole: membership.projectRole,
      allocationPct: membership.allocationPct,
      label: named.get(membership.userId) ?? membership.userId,
    }))
    .sort((a, b) => Number(b.projectRole === 'LEAD') - Number(a.projectRole === 'LEAD'));
};
