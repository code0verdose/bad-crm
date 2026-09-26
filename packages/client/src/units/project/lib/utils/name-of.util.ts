import { type PersonName } from '@units/project/types';

import { personLabel } from './person-label.util.js';

/**
 * The name of one account among the people the reader may see, or its id when they may see none.
 *
 * The id rather than a blank: the project answers with ids on purpose, and a reader without
 * `user:read` gets no directory — an empty label would hide that somebody is there at all.
 */
export const nameOf = (userId: string, people: readonly PersonName[]): string => {
  const person = people.find((candidate) => candidate.userId === userId);

  return person === undefined ? userId : personLabel(person);
};
