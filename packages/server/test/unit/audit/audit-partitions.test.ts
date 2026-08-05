import { describe, expect, it } from 'vitest';

import {
  monthsToEnsure,
  partitionDate,
  PARTITION_HORIZON_MONTHS,
} from '../../../scripts/audit-partitions.util.js';

/**
 * Which months the maintenance command creates — the arithmetic, without a database.
 *
 * Both cases below are the ones that are wrong when this is written inline: a year boundary, and a
 * run on a day the next month does not have. Neither shows up in a January-to-November test, and
 * both produce the same symptom — a month with no partition, which is a month where every insert
 * fails the transaction it was auditing.
 */

const dates = (now: string): string[] => monthsToEnsure(new Date(now)).map(partitionDate);

describe('the months the audit trail needs', () => {
  it('covers this month and the horizon beyond it', () => {
    expect(dates('2026-08-05T09:00:00Z')).toEqual(['2026-08-01', '2026-09-01', '2026-10-01']);
    expect(dates('2026-08-05T09:00:00Z')).toHaveLength(PARTITION_HORIZON_MONTHS + 1);
  });

  it('rolls over the year', () => {
    expect(dates('2026-12-31T23:59:59Z')).toEqual(['2026-12-01', '2027-01-01', '2027-02-01']);
  });

  it('does not invent a 31st of a month that has 30 days', () => {
    // `Date.UTC(year, month + n, 1)` pins the day, so 31 January + 1 month is 1 February rather than
    // the 31st of February rolling into March — which would leave February with no partition.
    expect(dates('2027-01-31T12:00:00Z')).toEqual(['2027-01-01', '2027-02-01', '2027-03-01']);
  });

  it('is anchored to UTC, not to the machine the command runs on', () => {
    // 1 March 00:30 UTC is still February in half the world. The partition boundaries are UTC
    // because `occurred_at` is `timestamptz` and PostgreSQL compares them in UTC — a horizon
    // computed in local time would be an hour of every month written into the DEFAULT partition.
    expect(dates('2027-03-01T00:30:00Z')[0]).toBe('2027-03-01');
  });
});
