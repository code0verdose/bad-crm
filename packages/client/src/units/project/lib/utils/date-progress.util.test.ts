import { describe, expect, it } from 'vitest';

import { dateProgress } from './date-progress.util.js';

/**
 * «Прогресс по датам» of STORY-014-05 acceptance 4: how far the calendar has moved between the
 * start and the deadline — never a claim about the work, which is the tasks' business (M3).
 */

const START = '2026-09-01T00:00:00.000Z';
const DUE = '2026-09-11T00:00:00.000Z';

const at = (iso: string): Date => new Date(iso);

describe('dateProgress', () => {
  it.each([
    { name: 'no dates at all', startedAt: null, dueAt: null },
    { name: 'a start and no deadline', startedAt: START, dueAt: null },
    { name: 'a deadline and no start', startedAt: null, dueAt: DUE },
  ])('has nothing to measure with $name', ({ startedAt, dueAt }) => {
    expect(dateProgress(startedAt, dueAt, at('2026-09-05T00:00:00.000Z'))).toBeNull();
  });

  it('is the share of the span already behind us, floored to a whole percent', () => {
    // 4 days 7 hours of 10 behind is 42.9 %: floored, so the bar never runs ahead of the calendar.
    expect(dateProgress(START, DUE, at('2026-09-05T07:00:00.000Z'))).toEqual({
      percent: 42,
      isOverdue: false,
    });
  });

  it('is zero before the project has started, not a negative share', () => {
    expect(dateProgress(START, DUE, at('2026-08-20T00:00:00.000Z'))).toEqual({
      percent: 0,
      isOverdue: false,
    });
  });

  it('stops at a hundred past the deadline and says the project is overdue', () => {
    expect(dateProgress(START, DUE, at('2026-09-20T00:00:00.000Z'))).toEqual({
      percent: 100,
      isOverdue: true,
    });
  });

  it('is a hundred and not yet overdue at the very instant of the deadline', () => {
    expect(dateProgress(START, DUE, at(DUE))).toEqual({ percent: 100, isOverdue: false });
  });

  it('does not divide by zero when the project starts and ends on the same instant', () => {
    expect(dateProgress(DUE, DUE, at('2026-09-10T00:00:00.000Z'))).toEqual({
      percent: 0,
      isOverdue: false,
    });
    expect(dateProgress(DUE, DUE, at('2026-09-12T00:00:00.000Z'))).toEqual({
      percent: 100,
      isOverdue: true,
    });
  });
});
