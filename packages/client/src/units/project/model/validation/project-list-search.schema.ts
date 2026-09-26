import { z } from 'zod';

import { SharedLib } from '@shared';

import { PROJECT_STATUSES } from '@units/project/model/enums/project-status.enums.js';

/**
 * The state of `/projects`, as the URL carries it (STORY-014-04, acceptance 1;
 * `rules/lists-and-filters.mdc` §1–3).
 *
 * **It extends the shared list schema** (`rules/frontend-fsd.mdc` rule 13) for `perPage`, and takes
 * `sort` from its whitelist factory (rule 14), so «page size» and «an order this list supports» mean
 * the same as on every other list, and `page` — bounded by the server's `MAX_PAGE` in the shared
 * schema itself. One shared field is restated on purpose, because the shared one is looser than this
 * endpoint: `q` — the server refuses more than 64 characters (`listProjects`, `q.maxLength`), and a
 * link carrying 65 would render the error state instead of the list.
 *
 * `cursor` is dropped: projects are an offset table (`rules/lists-and-filters.mdc` §9).
 *
 * **Every field falls back with `.catch`**, as the directory's schema does and for its reason: a
 * failed `validateSearch` replaces the screen with the error boundary, and `replace: true` keeps the
 * broken address in the bar.
 *
 * There is no `client` field: the server answers it `422` until STORY-014-07 brings clients.
 */

/** The columns `GET /projects` orders by; each also descending (`-name`). */
export const PROJECT_LIST_SORT_KEYS = ['name', 'key', 'createdAt'] as const;

/** Written out in the order the sort picker offers them. */
export const PROJECT_LIST_SORTS = [
  'name',
  '-name',
  'key',
  '-key',
  'createdAt',
  '-createdAt',
] as const;

export type ProjectListSort = (typeof PROJECT_LIST_SORTS)[number];

/**
 * How the same projects are drawn. Cards first: a project is recognised by its colour, key and
 * name at a glance, and the table is the dense view for somebody comparing many.
 */
export const PROJECT_LIST_VIEWS = ['grid', 'table'] as const;

export type ProjectListView = (typeof PROJECT_LIST_VIEWS)[number];

/** `member` takes one word: whose memberships «me» means is the session's to say (acceptance 8). */
export const PROJECT_MEMBER_FILTERS = ['me'] as const;

/** The server's bound on the search text (`listProjects`, `q.maxLength`). */
export const PROJECT_QUERY_MAX = 64;

export const projectListSearchSchema = SharedLib.listSearchSchemaWithSort(
  PROJECT_LIST_SORT_KEYS,
  'name',
)
  .omit({ cursor: true })
  .extend({
    q: z
      .string()
      .trim()
      .max(PROJECT_QUERY_MAX)
      .transform((value) => (value === '' ? undefined : value))
      .optional()
      .catch(undefined),
    /** Empty means the server's default — everything but the archive. */
    status: z.array(z.enum(PROJECT_STATUSES)).max(PROJECT_STATUSES.length).catch([]).default([]),
    lead: z.uuid().optional().catch(undefined),
    member: z.enum(PROJECT_MEMBER_FILTERS).optional().catch(undefined),
    view: z.enum(PROJECT_LIST_VIEWS).catch('grid').default('grid'),
  });

export type ProjectListSearch = z.infer<typeof projectListSearchSchema>;
