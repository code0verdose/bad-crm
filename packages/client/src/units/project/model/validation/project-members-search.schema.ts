import { z } from 'zod';

import { PROJECT_ROLES } from '@units/project/model/enums/project-role.enums.js';

/**
 * The state of `/projects/$projectId/members`, as the URL carries it (STORY-014-02, acceptance 10;
 * `rules/lists-and-filters.mdc` §1–3).
 *
 * **Narrowed on the client, by contract.** `GET /projects/{projectId}/members` takes no filter and
 * no page: it answers the whole live roster in one response, and it carries user ids, not names —
 * the names come from the directory, on the client. So the phrase can only be matched here, against
 * the rows the screen already holds, the arrangement of the second-factor coverage report
 * (`organization-settings-search.schema.ts`). The URL is still the state, so the narrowing survives
 * a reload and travels as a link. There is no `page` and no `sort`: the roster is not paged, and its
 * order (the lead first, then joining order) is the roster's own.
 *
 * Not the shared `listSearchSchema`: every field of it but `q` would describe a page that does not
 * exist, and its `q` has no bound.
 *
 * **Every field falls back with `.catch`**, for the reason the project list gives: a failed
 * `validateSearch` replaces the section with the error boundary, and `replace: true` keeps the
 * broken address in the bar.
 *
 * «People who left» is not a field yet: see the story's «Открыто по клиенту».
 */

/** Long enough for a full name. */
export const PROJECT_MEMBER_QUERY_MAX = 64;

export const projectMembersSearchSchema = z.object({
  q: z
    .string()
    .trim()
    .max(PROJECT_MEMBER_QUERY_MAX)
    .transform((value) => (value === '' ? undefined : value))
    .optional()
    .catch(undefined),
  role: z.array(z.enum(PROJECT_ROLES)).max(PROJECT_ROLES.length).catch([]).default([]),
});

export type ProjectMembersSearch = z.infer<typeof projectMembersSearchSchema>;
