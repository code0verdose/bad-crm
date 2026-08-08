import { roleIdSchema, teamIdSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

import {
  DIRECTORY_SORTS,
  DIRECTORY_STATUSES,
} from '@/application/iam/ports/employee-directory-repository.port.js';

/**
 * The query string of the directory.
 *
 * **A repeated parameter and a single one are the same shape here.** `?role=a&role=b` reaches
 * Express as an array and `?role=a` as a string, and every list filter in this API would otherwise
 * carry the same two-case branch downstream. Normalising once, at the boundary, is what
 * `rules/zod-validation.mdc` §3 asks for — and it is the difference between a filter that works and
 * one that works only with two values selected.
 *
 * **A rejected value is a 422 `validation_failed`, not a silent default.** The opposite choice belongs on the client,
 * where a hand-edited address bar must not replace the screen with an error boundary
 * (`member-list-search.schema.ts` uses `.catch` for exactly that). Here, an unknown status or an
 * `id` that is not a UUID means a client sent something it should not have, and answering «here is
 * everybody» would hide the defect behind a plausible page.
 */

/** How many rows one page may carry. The `OffsetPage` envelope of the spec bounds it at 100. */
const PER_PAGE_MIN = 1;
const PER_PAGE_MAX = 100;
const PER_PAGE_DEFAULT = 25;

/** Long enough for a full name plus a job title; beyond that it is not a search. */
const MAX_QUERY = 64;

/**
 * One value or many, always answered as many.
 *
 * `preprocess` rather than a union of «array or scalar»: the branch has to happen before the item
 * schema runs, and doing it here means the item schema — a UUID, a status — is stated once.
 */
const repeatable = <T extends z.ZodType>(item: T): z.ZodType<z.output<T>[], unknown> =>
  z.preprocess(
    (value: unknown): unknown[] =>
      value === undefined ? [] : Array.isArray(value) ? value : [value],
    z.array(item),
  );

export const employeeDirectoryQuerySchema = z.strictObject({
  q: z.string().trim().max(MAX_QUERY).optional().default(''),
  status: repeatable(z.enum(DIRECTORY_STATUSES)),
  role: repeatable(roleIdSchema),
  team: repeatable(teamIdSchema),
  sort: z.enum(DIRECTORY_SORTS).optional().default('name'),
  // `coerce`, because a query string carries digits and not numbers. `int()` after it, so that
  // `?page=1.5` is refused rather than floored into a page nobody asked for.
  page: z.coerce.number().int().min(1).optional().default(1),
  perPage: z.coerce
    .number()
    .int()
    .min(PER_PAGE_MIN)
    .max(PER_PAGE_MAX)
    .optional()
    .default(PER_PAGE_DEFAULT),
});

export type EmployeeDirectoryQuery = z.output<typeof employeeDirectoryQuerySchema>;

/** The chart takes nothing: it is the whole organization, and there is nothing to narrow it by. */
export const orgChartQuerySchema = z.strictObject({});
