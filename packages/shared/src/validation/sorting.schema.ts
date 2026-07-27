import { z } from 'zod';

export const SORT_ORDERS = ['asc', 'desc'] as const;

/** Sort direction. Ascending is the default so a list is never returned in an arbitrary order. */
export const sortOrderSchema = z
  .enum(SORT_ORDERS, { error: 'validation.sort.invalid_order' })
  .default('asc');

export type SortOrder = (typeof SORT_ORDERS)[number];

/**
 * Builds the sort schema of one list, closed over the fields that list is actually allowed to sort
 * by.
 *
 * A free-form `sortBy` string is a data leak waiting to happen: it reaches an `ORDER BY`, and an
 * attacker learns the ordering of a column they cannot read. The whitelist lives in the schema, so
 * the rejection happens at the boundary rather than in a query builder.
 */
export const sortSchema = <const TFields extends readonly [string, ...string[]]>(
  sortableFields: TFields,
) =>
  z.object({
    sortBy: z.enum(sortableFields, { error: 'validation.sort.unknown_field' }).optional(),
    sortOrder: sortOrderSchema,
  });
