import { describe, expect, it } from 'vitest';

import { nextTab } from './next-tab.util.js';

/**
 * The tab list has one entry today, so the refusal below cannot be produced by clicking anything —
 * which is precisely why it is asserted here rather than through the screen. The day a second tab
 * lands, «what happens to a value that is not a tab» is already answered.
 */
describe('nextTab', () => {
  it.each([
    ['a tab that exists', 'security', 'security'],
    ['a tab that does not', 'billing', 'security'],
    ['no tab at all', null, 'security'],
  ])('answers %s', (_case, value, expected) => {
    expect(nextTab(value, 'security')).toBe(expected);
  });
});
