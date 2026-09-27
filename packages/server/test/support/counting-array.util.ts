/**
 * An array that counts how many of its elements were read — for asserting that code walks a list
 * a bounded number of times, without a stopwatch.
 *
 * Every element read goes through the proxy's `get` trap with a numeric key: an index expression,
 * `for…of` (the array iterator reads by index through the proxy), `filter`, `map`, `forEach`. A
 * per-person `rows.filter(…)` over N people and N rows reads N² elements; grouping once reads N.
 * The count is therefore a shape of the algorithm, not a timing, and does not flake on a loaded
 * machine.
 */
export interface CountingArray<T> {
  readonly rows: T[];
  readonly reads: () => number;
}

export const countingArray = <T>(source: readonly T[]): CountingArray<T> => {
  let reads = 0;
  const rows = new Proxy([...source], {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;

      return Reflect.get(target, key, receiver) as unknown;
    },
  });

  return { rows, reads: () => reads };
};
