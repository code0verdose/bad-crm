import { type PersonNameParts } from './person-name.types.js';

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
 * **Why in `shared/lib/format` and not in `units/employee`.** Five files spelled this rule — four
 * in three widgets and one in the project unit — and the copy in `widgets/invitation-list` promised to move
 * «to a unit that owns people» when a third screen needed it. It cannot: units do not import each
 * other (`test/architecture/layers.test.ts`, «keeps units independent of each other»), and the
 * project unit is one of the callers, so `shared` is the only layer every caller can reach. It is
 * allowed there because it knows no domain (`rules/frontend-fsd.mdc` rule 8): two structural fields
 * and a fallback the caller picks — no address, no id, no directory — which makes it display
 * formatting of a name, the same kind of thing as `formatList` of names.
 */
export const personLabel = (person: PersonNameParts, fallback: string): string => {
  const full = `${person.firstName} ${person.lastName}`.trim();

  return full === '' ? fallback : full;
};
