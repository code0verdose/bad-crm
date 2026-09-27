import { z } from 'zod';

/**
 * One query parameter or many, always answered as many.
 *
 * `?role=a&role=b` reaches Express as an array and `?role=a` as a string, and every list filter in
 * this API would otherwise carry the same two-case branch downstream. Normalising once, at the
 * boundary, is what `rules/zod-validation.mdc` §3 asks for — and it is the difference between a
 * filter that works and one that works only with two values selected.
 *
 * `preprocess` rather than a union of «array or scalar»: the branch has to happen before the item
 * schema runs, and doing it here means the item schema — a UUID, a status — is stated once.
 */
export const repeatable = <T extends z.ZodType>(
  item: T,
  /** At most this many values; more is a `422` `too_big` on the parameter. */
  max?: number,
): z.ZodType<z.output<T>[], unknown> =>
  z.preprocess(
    (value: unknown): unknown[] =>
      value === undefined ? [] : Array.isArray(value) ? value : [value],
    max === undefined ? z.array(item) : z.array(item).max(max),
  );
