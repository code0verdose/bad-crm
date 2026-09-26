import { type PersonNameParts } from '@units/employee/types';

/**
 * A person as one string, and never an empty one.
 *
 * **Why the fallback is common rather than an edge case.** A personnel record nobody has filled in
 * carries empty names — the directory answers with an empty row when there is no `EmployeeProfile`,
 * and neither registration nor accepting an invitation creates one — so «first plus last» is empty
 * on the ordinary record. A cell, an option or a link with no text is one nobody can read or choose.
 *
 * **Why the caller names the fallback.** The answers differ in what they carry: a directory row has
 * the address, an org-chart node has only the id. Choosing inside would mean either a second
 * function or a guess at which field is present.
 *
 * **Why here, in `units/employee`.** Five screens spelled this rule five times, and the one written
 * in `widgets/invitation-list` said it would move «to a unit that owns people» when a third screen
 * needed it. What to call a person is domain knowledge — the product's policy for an unnamed
 * record — so it is not `shared/lib/format` (`rules/frontend-fsd.mdc` rule 8), and the unit that owns
 * the directory is the one that owns people.
 */
export const personLabel = (person: PersonNameParts, fallback: string): string => {
  const full = `${person.firstName} ${person.lastName}`.trim();

  return full === '' ? fallback : full;
};
