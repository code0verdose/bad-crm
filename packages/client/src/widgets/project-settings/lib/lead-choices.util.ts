import { ProjectLib, type ProjectTypes } from '@units/project';

export interface LeadChoice {
  readonly value: string;
  readonly label: string;
}

/**
 * Who the settings form offers as the lead.
 *
 * **Only the current lead, unless the card says the reader may change it.** A changed `leadId` needs
 * `project:manage_members` on top of `project:update` — the new lead gets a `LEAD` seat, which is a
 * change of rights — and the card's `permissions.canManageMembers` is the server's answer to exactly
 * that. Offering the whole directory to somebody without it would be offering a save that is certain
 * to be refused. The flag decides; nothing here derives a right from a role.
 *
 * The current lead is always among the choices, named when the directory names them: a lead whose
 * account was switched off since is not in the directory's default answer, and a select that could
 * not show the stored value would silently move the project to the first name on the list.
 */
export const leadChoices = (
  people: readonly ProjectTypes.PersonName[],
  currentLeadId: string,
  mayChange: boolean,
): readonly LeadChoice[] => {
  const current = { value: currentLeadId, label: ProjectLib.nameOf(currentLeadId, people) };

  if (!mayChange) return [current];

  const everybody = ProjectLib.leadOptions(people);

  return everybody.some((choice) => choice.value === currentLeadId)
    ? everybody
    : [current, ...everybody];
};
