import { z } from 'zod';

/**
 * The fields every list screen shares (`ux-architecture.md` → «Карта маршрутов», conventions).
 *
 * A list route extends this rather than restating it, so that «page 2» means the same thing on the
 * backlog and in the audit log, and one change to pagination reaches both. It lives in
 * `shared/lib/validation` because it carries no domain: `rules/zod-validation.mdc` rule 11 puts the
 * reusable primitives here and the per-entity filters in `units/<unit>/model/validation`.
 *
 * `z.coerce` throughout, because a URL has only strings — `?page=2` arrives as `'2'`, and a schema
 * that expected a number would reject every real navigation.
 *
 * Everything is `.catch(...)`, never a throw: these values come from the address bar — a shared
 * link, a stale bookmark, a hand-edited URL — and a screen that crashes on `?page=abc` is a screen
 * that crashes on a link somebody sent a colleague. Rubbish falls back to the default and the page
 * renders (`rules/zod-validation.mdc`, `rules/lists-and-filters.mdc`).
 */

/** Matches the server's cap; a larger page is a request the API refuses anyway. */
export const MAX_PER_PAGE = 100;

export const DEFAULT_PAGE = 1;
export const DEFAULT_PER_PAGE = 25;

/** `-createdAt` is `createdAt` descending — one parameter, not a second `order=desc`. */
export const DESCENDING_PREFIX = '-';

/**
 * Trimmed, and empty means «no filter» rather than «match the empty string».
 *
 * The same treatment serves `q` and `cursor`: a blank cursor is not «resume from the beginning», it
 * is a parameter the previous page left behind, and forwarding it asks the API to resume from
 * nowhere.
 */
const optionalText = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional()
  .catch(undefined);

export const listSearchSchema = z.object({
  page: z.coerce.number().int().min(1).catch(DEFAULT_PAGE).default(DEFAULT_PAGE),
  perPage: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PER_PAGE)
    .catch(DEFAULT_PER_PAGE)
    .default(DEFAULT_PER_PAGE),
  /** Keyset pagination, for the endpoints that page by cursor instead of by offset. */
  cursor: optionalText,
  q: optionalText,
});

export type ListSearch = z.infer<typeof listSearchSchema>;

/**
 * The `sort` field, as a whitelist — which is the only form it may take.
 *
 * It is a factory rather than a field of the schema above because the accepted keys are a property
 * of one list, not of lists in general, and there is no safe generic answer: the value reaches an
 * `ORDER BY` on the server, so «any string» is an injection surface and a 500 waiting for the first
 * person to hand-edit a URL. A route declares its columns; anything else falls back to the default
 * exactly like a bad `page` does.
 */
export type SortValue<TKey extends string> = TKey | `${typeof DESCENDING_PREFIX}${TKey}`;

export const sortSchema = <const TKey extends string>(
  keys: readonly [TKey, ...TKey[]],
  fallback: SortValue<TKey>,
) => {
  const accepted = new Set<string>(keys.flatMap((key) => [key, `${DESCENDING_PREFIX}${key}`]));

  /**
   * `z.custom` rather than `z.enum` over the expanded list: the accepted values are computed from a
   * type parameter, and `z.enum` infers its union from a literal tuple — handed a generic array it
   * widens the result back to `string`, which is precisely the type this field must not have.
   */
  return z
    .custom<SortValue<TKey>>((value) => typeof value === 'string' && accepted.has(value))
    .catch(fallback)
    .default(fallback);
};

/** The shared fields plus a sort this route actually supports — what a sortable list validates. */
export const listSearchSchemaWithSort = <const TKey extends string>(
  keys: readonly [TKey, ...TKey[]],
  fallback: SortValue<TKey>,
) => listSearchSchema.extend({ sort: sortSchema(keys, fallback) });
