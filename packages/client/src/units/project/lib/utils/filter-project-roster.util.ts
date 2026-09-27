import { type ProjectMembersSearch } from '@units/project/model/validation/project-members-search.schema.js';

import { type ProjectRosterRow } from './project-roster.util.js';

/**
 * The roster narrowed by the URL (STORY-014-02, acceptance 10) — on the client, because the endpoint
 * answers the whole roster and knows no names (`project-members-search.schema.ts`).
 *
 * The phrase is matched anywhere in the label, case-insensitively — the label is what the reader
 * sees, so it is what they type: a name where the directory is readable, the id where it is not.
 * A row has to satisfy every filter that is on. The order is kept.
 */
export const filterProjectRoster = (
  rows: readonly ProjectRosterRow[],
  { q, role }: ProjectMembersSearch,
): readonly ProjectRosterRow[] => {
  const phrase = q?.toLowerCase();

  return rows.filter(
    (row) =>
      (role.length === 0 || role.includes(row.projectRole)) &&
      (phrase === undefined || row.label.toLowerCase().includes(phrase)),
  );
};
