import { z } from 'zod';

/**
 * The state of the team list, as the URL carries it (`rules/lists-and-filters.mdc` §1).
 *
 * **`GET /teams` accepts no parameters at all**, and that is what makes this schema worth reading
 * rather than skimming. The endpoint publishes every live team of the organization in one document,
 * so nothing here is sent anywhere: the phrase, the order and the page are applied to the answer.
 *
 * They still live in the address bar, for the reasons that have nothing to do with the request — a
 * view has to survive a reload, work with the back button, and be sendable to a colleague. What
 * changes is where they must **not** appear: the query key. A key carrying the phrase would keep one
 * cache entry per thing somebody typed, all of them copies of the same answer.
 *
 * **Every field falls back with `.catch` rather than `.default`.** A default fills in an *absent*
 * value; a present one that means nothing — `?sort=budget`, a page that is a word — fails
 * validation, and a failed `validateSearch` replaces the screen with the error boundary. With
 * `replace: true` on every filter change that broken address also stays in the bar, so a reload does
 * not help. The server does the opposite and answers 422, because there an unknown value means a
 * client sent something it should not have.
 */

/**
 * How the rows may be ordered.
 *
 * Size is here because it is the question a team list is usually opened with — «кто у нас большой» —
 * and it is answerable without a second request: `memberCount` is on every row of the answer.
 */
export const TEAM_SORTS = ['name', '-name', 'members', '-members'] as const;

export type TeamSort = (typeof TEAM_SORTS)[number];

/** Long enough for a team name plus a word. */
const MAX_QUERY = 64;

export const teamListSearchSchema = z.object({
  q: z.string().trim().max(MAX_QUERY).catch(''),
  sort: z.enum(TEAM_SORTS).catch('name'),
  page: z.coerce.number().int().min(1).catch(1),
});

export type TeamListSearch = z.infer<typeof teamListSearchSchema>;
