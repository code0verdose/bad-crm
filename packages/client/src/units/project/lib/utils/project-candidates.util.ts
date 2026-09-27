import { SharedLib } from '@shared';

import { type PersonName } from '@units/project/types';

export interface ProjectCandidate {
  readonly value: string;
  readonly label: string;
}

/**
 * Who can still be put on this project: everybody the directory answered with, minus everybody
 * already on it, minus the reader.
 *
 * The reader is left out because the server refuses them whatever key they hold
 * (`403 self_assignment_forbidden`, `T-PROJ-02`): offering a choice that is certain to be refused is
 * a control that does not work. That is a courtesy of the picker, not the rule — the rule is the
 * server's, and it holds for a request this picker never made.
 */
export const projectCandidates = (
  people: readonly PersonName[],
  memberIds: readonly string[],
  readerId: string | undefined,
): readonly ProjectCandidate[] => {
  const excluded = new Set(memberIds);

  if (readerId !== undefined) excluded.add(readerId);

  return people
    .filter((person) => !excluded.has(person.userId))
    .map((person) => ({
      value: person.userId,
      label: SharedLib.personLabel(person, person.email),
    }));
};

/**
 * The people a lead can be chosen from — the whole directory, the reader included (creating a
 * project one leads oneself is allowed), labelled the way every roster labels them.
 */
export const leadOptions = (people: readonly PersonName[]): readonly ProjectCandidate[] =>
  people.map((person) => ({
    value: person.userId,
    label: SharedLib.personLabel(person, person.email),
  }));
