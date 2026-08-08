import { z } from 'zod';

/**
 * The state of the directory, as the URL carries it (`rules/lists-and-filters.mdc` §1).
 *
 * The whole filter lives here rather than in component state, so a view survives a reload, works
 * with the back button and can be sent to a colleague — «кто у нас на бэкенде» is a link, not a
 * description of six clicks.
 *
 * **Every field falls back with `.catch` rather than `.default`.** A default fills in an *absent*
 * value; a present one that means nothing — `?sort=salary`, a status that is not a status, a page
 * that is a word — fails validation, and a failed `validateSearch` replaces the screen with the
 * error boundary. With `replace: true` on every filter change that broken address also stays in the
 * bar, so a reload does not help. The server does the opposite and answers 422: there an unknown
 * value means a client sent something it should not have, and a plausible page would hide the
 * defect.
 *
 * **Arrays are arrays, not `role[]=` strings.** The literal spelling in `ux-architecture.md` is the
 * notation for «this parameter is a list»; how a list is written into the address bar belongs to the
 * router's own serializer, and overriding that globally would rewrite the URLs of every other screen
 * to fix the punctuation of one.
 */

export const MEMBER_STATUSES = ['ACTIVE', 'SUSPENDED', 'INVITED'] as const;

export const MEMBER_SORTS = ['name', '-name', 'hiredAt', '-hiredAt'] as const;

export type MemberSort = (typeof MEMBER_SORTS)[number];

/**
 * Which way the same people are shown.
 *
 * In the URL rather than in `useState`, and for two reasons: «посмотри, кто кому подчиняется» should
 * be a link, and the chart is behind its own permission — so the request for it is made only in the
 * view that draws it, which local state could not distinguish from «not decided yet».
 */
export const MEMBER_VIEWS = ['table', 'chart'] as const;

export type MemberView = (typeof MEMBER_VIEWS)[number];

/** Long enough for a full name plus a job title. The server bounds it identically. */
const MAX_QUERY = 64;

/** How many rows a page carries. Not in the URL: it is a property of the screen, not of the view. */
export const MEMBERS_PER_PAGE = 25;

const idList = z.array(z.uuid()).max(20).catch([]);

export const memberListSearchSchema = z.object({
  q: z.string().trim().max(MAX_QUERY).catch(''),
  /** Empty means the screen's default — active and invited — which the **server** decides. */
  status: z.array(z.enum(MEMBER_STATUSES)).max(MEMBER_STATUSES.length).catch([]),
  role: idList,
  team: idList,
  sort: z.enum(MEMBER_SORTS).catch('name'),
  page: z.coerce.number().int().min(1).catch(1),
  view: z.enum(MEMBER_VIEWS).catch('table'),
});

export type MemberListSearch = z.infer<typeof memberListSearchSchema>;

/**
 * The filters, without the page — what a change to any of them resets the page **because of**.
 *
 * Named here rather than spelled at the call site, so «did I remember to reset the page» has one
 * answer: a filter is anything in this list, and changing one starts at page 1.
 */
export const MEMBER_FILTER_FIELDS = ['q', 'status', 'role', 'team', 'sort'] as const;
