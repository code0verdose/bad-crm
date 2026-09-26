import { SharedLib } from '@shared';

import { type PersonName } from '@units/project/types';

/** The fields of a list item the rows read — structural, so `lib` does not name the contract. */
export interface ProjectListEntry {
  readonly leadId: string;
}

export type ProjectListRow<TItem extends ProjectListEntry> = TItem & {
  /** The lead's name when the reader may see the directory, their id otherwise (`nameOf`). */
  readonly leadLabel: string;
};

export interface ProjectLeadOption {
  readonly value: string;
  readonly label: string;
}

const labels = (people: readonly PersonName[]): Map<string, string> =>
  new Map(people.map((person) => [person.userId, SharedLib.personLabel(person, person.email)]));

/**
 * The page joined with the directory: each project with its lead's name.
 *
 * One lookup table for the page rather than a search per card. The id stands in for a name the
 * reader may not be told — the list answers with ids on purpose, and a blank would hide that the
 * project has a lead at all.
 */
export const projectListRows = <TItem extends ProjectListEntry>(
  items: readonly TItem[],
  people: readonly PersonName[],
): ProjectListRow<TItem>[] => {
  const named = labels(people);

  return items.map((item) => ({ ...item, leadLabel: named.get(item.leadId) ?? item.leadId }));
};

/**
 * The leads the filter offers — the facet of the answer, so a lead of a project the reader cannot
 * see is never offered (acceptance 5), named from the directory where it may be read.
 */
export const projectLeadOptions = (
  leadIds: readonly string[],
  people: readonly PersonName[],
): ProjectLeadOption[] => {
  const named = labels(people);

  return leadIds.map((leadId) => ({ value: leadId, label: named.get(leadId) ?? leadId }));
};
