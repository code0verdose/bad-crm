/**
 * The two numbers `pnpm db:audit-retention` and the environment schema have to agree on.
 *
 * Kept in `src/` and not in `scripts/` because `env.schema.ts` is the first reader: the schema
 * refuses a threshold outside the interval before any command starts, and the command refuses the
 * same interval again at its own door (`assertRetentionMonths`) — for a caller that never went
 * through the schema. One constant, so the two doors cannot disagree about what «under a year» is.
 */

/**
 * Months of the audit trail a retention threshold may name.
 *
 * Twelve is the floor because a threshold under a year is nearly always a unit mistake (days,
 * weeks) and the cost of obeying it is a year of evidence gone. Six hundred — fifty years — is the
 * ceiling because past it the number spells «never», and «never» is spelled by leaving the
 * variable unset. Documented next to `AUDIT_RETENTION_MONTHS` in `env.schema.ts`.
 */
export const AUDIT_RETENTION_MONTHS_RANGE = Object.freeze({ min: 12, max: 600 });

/**
 * The session-level advisory lock one retention run holds for its whole duration.
 *
 * Two runs at once — cron and an operator by hand — race for the same `DETACH`; the loser fails
 * with `is not a partition`, which the command could only report as a broken configuration, and
 * the rest of its plan goes unprocessed. `pg_try_advisory_lock` on this key is what makes the
 * second run say «another run holds the lock» and stop before touching anything. The number is
 * arbitrary and only has to be unique among the advisory keys this project takes; today it is the
 * only one (`grep -rn advisory_lock packages/server`).
 */
export const AUDIT_RETENTION_ADVISORY_LOCK_KEY = 1605;
