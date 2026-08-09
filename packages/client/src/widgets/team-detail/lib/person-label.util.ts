import { type EmployeeApi } from '@units/employee';

/**
 * A person, as one string, and never an empty one.
 *
 * The address is the fallback rather than a blank: a personnel record nobody has filled in carries
 * empty names — the repository answers with an empty row when there is no `EmployeeProfile`, and
 * neither registration nor accepting an invitation creates one — so «first plus last» is empty on the
 * ordinary record rather than on an edge case. An option in a picker with no text is an option
 * nobody can choose on purpose.
 */
export const personLabel = (person: EmployeeApi.EmployeeListItem): string => {
  const full = `${person.firstName} ${person.lastName}`.trim();

  return full === '' ? person.email : full;
};
