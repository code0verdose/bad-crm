import { z } from 'zod';

/** Default page size, shared by both pagination styles (stack.md, «Пагинация»). */
export const DEFAULT_PAGE_SIZE = 50;

/** Hard upper bound: a client cannot ask for an unbounded page. */
export const MAX_PAGE_SIZE = 100;

/**
 * The last page an offset list serves: `page × MAX_PAGE_SIZE` ≤ 2^31 − 1, so the offset of any
 * page at any allowed size fits a 32-bit signed integer. Beyond it the number is not a page anybody
 * reaches by paging, only a value to be carried to the database and back — a larger one is refused
 * (`422` on `page`), not answered with an empty page. Every offset list shares it, whatever its own
 * page size, as long as that size is capped at `MAX_PAGE_SIZE`.
 */
export const MAX_PAGE = Math.floor((2 ** 31 - 1) / MAX_PAGE_SIZE);

const pageSize = z.coerce
  .number({ error: 'validation.pagination.invalid' })
  .int({ error: 'validation.pagination.invalid' })
  .min(1, { error: 'validation.pagination.invalid' })
  .max(MAX_PAGE_SIZE, { error: 'validation.pagination.too_large' })
  .default(DEFAULT_PAGE_SIZE);

/**
 * Offset pagination — tables (tasks, projects, employees, invoices): the user needs "page 7 of 42",
 * arbitrary sorting and an exact count.
 *
 * `z.coerce` is mandatory here: these values arrive from a URL query string, where everything is a
 * string (rules/zod-validation.mdc, rule 6).
 */
export const offsetPageSchema = z.object({
  page: z.coerce
    .number({ error: 'validation.pagination.invalid' })
    .int({ error: 'validation.pagination.invalid' })
    .min(1, { error: 'validation.pagination.invalid' })
    .max(MAX_PAGE, { error: 'validation.pagination.too_large' })
    .default(1),
  perPage: pageSize,
});

export type OffsetPage = z.infer<typeof offsetPageSchema>;

/**
 * Cursor pagination — feeds (activity, comments, chat, notifications, audit log): rows are appended
 * constantly, so an offset both duplicates and skips records.
 *
 * The cursor stays opaque on purpose — it is a base64url payload of `{ sortKey, id }` produced by
 * the server, and validating its contents here would leak the sort key into the client contract.
 */
export const cursorPageSchema = z.object({
  cursor: z.string().min(1, { error: 'validation.pagination.invalid_cursor' }).optional(),
  limit: pageSize,
});

export type CursorPage = z.infer<typeof cursorPageSchema>;
