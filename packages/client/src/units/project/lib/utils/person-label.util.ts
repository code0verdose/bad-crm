import { type PersonName } from '@units/project/types';

/** What a person is called on the card: the full name, or the address for somebody still unnamed. */
export const personLabel = (person: PersonName): string => {
  const full = `${person.firstName} ${person.lastName}`.trim();

  return full === '' ? person.email : full;
};
