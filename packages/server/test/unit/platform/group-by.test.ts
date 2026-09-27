import { describe, expect, it } from 'vitest';

import { groupBy } from '@/application/platform/group-by.util.js';

import { countingArray } from '../../support/counting-array.util.js';

/**
 * Grouping rows by a key in one pass — what replaced a per-person `filter` over a whole result
 * set in the audience reads (a visibility summary at 20 000 accounts was quadratic).
 */
describe('groupBy', () => {
  it('keeps every row, under its key, in the order it came', () => {
    const grouped = groupBy(
      [
        { userId: 'a', n: 1 },
        { userId: 'b', n: 2 },
        { userId: 'a', n: 3 },
      ],
      (row) => row.userId,
    );

    expect([...grouped.keys()]).toEqual(['a', 'b']);
    expect(grouped.get('a')?.map((row) => row.n)).toEqual([1, 3]);
    expect(grouped.get('b')?.map((row) => row.n)).toEqual([2]);
    expect(grouped.get('c')).toBeUndefined();
  });

  it('answers an empty map for no rows', () => {
    expect(groupBy([], () => 'x').size).toBe(0);
  });

  it('reads each row exactly once', () => {
    const rows = countingArray(Array.from({ length: 20_000 }, (_, n) => ({ userId: `u${n % 7}` })));

    groupBy(rows.rows, (row) => row.userId);

    expect(rows.reads()).toBe(20_000);
  });
});
