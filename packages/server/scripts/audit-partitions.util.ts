/**
 * Which months of the audit trail have to exist right now.
 *
 * A month with no partition is a month where every insert fails — and an insert here fails the
 * transaction it was auditing, so a missing partition stops the product rather than degrading it.
 * The DEFAULT partition is what makes that survivable; this is what makes it not happen.
 *
 * The horizon is **the current month plus two**, and the reason it is more than one is the failure
 * mode this guards against: the operator forgets to run it, or the deploy that would have run it is
 * postponed. Two months of slack means a missed run is noticed by a metric rather than by an outage.
 *
 * Separated from the database for the usual reason: «which months» is arithmetic over a date and can
 * be asserted without a container, including the two cases that are always wrong when this is
 * written inline — December rolling into January, and a run on the 31st of a month whose successor
 * has 30 days.
 */

/** The horizon, in months beyond the current one. */
export const PARTITION_HORIZON_MONTHS = 2;

/**
 * The first day of each month that must have a partition, starting with the month of `now`.
 *
 * Built by `Date.UTC(year, month + n, 1)`, which normalises an overflowing month index on its own:
 * month 12 of 2026 is January 2027, and the day is pinned to the 1st so a run on the 31st cannot
 * produce a date that does not exist.
 */
export const monthsToEnsure = (now: Date): Date[] =>
  Array.from(
    { length: PARTITION_HORIZON_MONTHS + 1 },
    (_, index) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + index, 1)),
  );

/** `2026-08-01` — what the SQL function takes, and what a log line should show. */
export const partitionDate = (month: Date): string => month.toISOString().slice(0, 10);
