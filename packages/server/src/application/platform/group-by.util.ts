/**
 * Rows grouped by a key, in one pass and in the order they came.
 *
 * For folding a result set read for many people at once: a per-person `rows.filter(...)` is one
 * walk of the whole result per person — quadratic in the size of the organization, which is what
 * took the visibility summary past the idle-transaction timeout. `Map.groupBy` would do this, but
 * it is ES2024 and the server compiles against ES2023.
 */
export const groupBy = <T, K>(rows: readonly T[], keyOf: (row: T) => K): ReadonlyMap<K, T[]> => {
  const grouped = new Map<K, T[]>();

  for (const row of rows) {
    const key = keyOf(row);
    const bucket = grouped.get(key);

    if (bucket === undefined) grouped.set(key, [row]);
    else bucket.push(row);
  }

  return grouped;
};
