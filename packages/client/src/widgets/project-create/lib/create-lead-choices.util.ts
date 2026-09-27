import { ProjectLib, type ProjectTypes } from '@units/project';

export interface CreateLeadChoice {
  readonly value: string;
  readonly label: string;
}

/**
 * Who the create form offers as the lead: the whole directory when the reader may see it, otherwise
 * the reader alone, under the translated «you» the caller passes (a label, not a key — the caller
 * owns the translation).
 */
export const createLeadChoices = (
  people: readonly ProjectTypes.PersonName[],
  readerId: string | undefined,
  youLabel: string,
): readonly CreateLeadChoice[] => {
  if (people.length > 0) return ProjectLib.leadOptions(people);

  return readerId === undefined ? [] : [{ value: readerId, label: youLabel }];
};
