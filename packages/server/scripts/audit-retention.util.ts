/**
 * What `pnpm db:audit-retention` decides, separated from what it executes.
 *
 * Retention is an operation on partitions and nothing else (STORY-016-05, acceptance 4): a month
 * of the trail is `DETACH`ed as a whole, which is a catalog change, where a `DELETE` over the same
 * rows is hours of locks and bloat — and a statement the application does not even hold the
 * privilege for. So the only decision worth making is *which months*, and that is arithmetic over
 * a date and a threshold, assertable without a container.
 *
 * Two facts anchor it. Partition names are `audit_logs_YYYY_MM` and cover `[month, month + 1)` at
 * midnight **in the session timezone the partition was created under** —
 * `create_audit_partition(date)` in the migration is the author of both name and bound, and it
 * does not pin UTC (the open item of STORY-016-05). The arithmetic here is UTC; the offset between
 * the two is absorbed by `BOUND_TOLERANCE_MS` in `audit-retention.commands.ts`. And a month is old
 * enough when **every row in it** is at least the threshold old, which is when the month *ends* on
 * or before the cutoff — not when it starts.
 */

import { AUDIT_RETENTION_MONTHS_RANGE } from '../src/infrastructure/persistence/prisma/audit-retention.constant.js';

/**
 * The bounds of `env.schema.ts`, enforced again at the function's own door.
 *
 * The schema guards the command line; this guards every other caller — a test, a future job — that
 * hands a number straight to `planRetention`. Without it `0` here would detach last month, and the
 * whole reason the schema refuses anything under a year is that such a number is nearly always a
 * unit mistake. `undefined` passes: it is «off», not a threshold.
 */
export const assertRetentionMonths = (months: number | undefined): void => {
  const { min, max } = AUDIT_RETENTION_MONTHS_RANGE;

  if (months === undefined) return;

  if (!Number.isInteger(months) || months < min || months > max) {
    throw new RangeError(
      `AUDIT_RETENTION_MONTHS must be between ${String(min)} and ${String(max)}, got ${String(months)}`,
    );
  }
};

/** The one partition that carries no month and is never a candidate for anything here. */
export const AUDIT_DEFAULT_PARTITION = 'audit_logs_default';

/** `audit_logs_2026_08`: the shape `create_audit_partition(date)` produces. */
export const AUDIT_PARTITION_NAME = /^audit_logs_(\d{4})_(\d{2})$/;

/** The first day of the month a dated partition covers, UTC; `undefined` for anything else. */
export const partitionMonth = (name: string): Date | undefined => {
  const match = AUDIT_PARTITION_NAME.exec(name);

  if (match === null) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);

  if (month < 1 || month > 12) return undefined;

  return new Date(Date.UTC(year, month - 1, 1));
};

/**
 * The first day of the month `months` before `now`, UTC.
 *
 * `Date.UTC` normalises a negative month index on its own — month −3 of 2026 is October 2025 — and
 * pinning the day to the 1st keeps a run on the 31st from producing a date that does not exist.
 */
export const retentionCutoff = (now: Date, months: number): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));

/** The exclusive upper bound of a partition's range: the first day of the following month. */
const partitionEnd = (month: Date): Date =>
  new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));

export interface RetentionPlanInput {
  readonly now: Date;
  /** `undefined` is «retention is off»: the variable is unset and nothing is ever detached. */
  readonly retentionMonths: number | undefined;
  /** Names of the partitions currently attached to `audit_logs`, DEFAULT included or not. */
  readonly partitions: readonly string[];
}

export interface RetentionPlan {
  /** Dated partitions whose last row is at least the threshold old, oldest first. */
  readonly detach: readonly string[];
  /** Every other attached partition except the DEFAULT one — including any this cannot date. */
  readonly keep: readonly string[];
}

/**
 * Which partitions to detach and which to leave alone.
 *
 * A partition this cannot date — a name somebody created by hand — is kept, not detached: guessing
 * an age for it would be guessing at evidence. The DEFAULT partition is on neither list, because it
 * is not old data; rows in it are the symptom of a month nobody created a partition for, and the
 * command reports on it separately.
 */
export const planRetention = ({
  now,
  retentionMonths,
  partitions,
}: RetentionPlanInput): RetentionPlan => {
  assertRetentionMonths(retentionMonths);

  const candidates = [...partitions].filter((name) => name !== AUDIT_DEFAULT_PARTITION).sort();

  if (retentionMonths === undefined) return { detach: [], keep: candidates };

  const cutoff = retentionCutoff(now, retentionMonths).getTime();
  const isOld = (name: string): boolean => {
    const month = partitionMonth(name);

    return month !== undefined && partitionEnd(month).getTime() <= cutoff;
  };

  return {
    detach: candidates.filter(isOld),
    keep: candidates.filter((name) => !isOld(name)),
  };
};

export type RetentionArguments =
  | { readonly mode: 'detach' }
  | { readonly mode: 'drop'; readonly tables: readonly string[] }
  | { readonly mode: 'error'; readonly message: string };

export const RETENTION_USAGE = `usage: pnpm db:audit-retention                       detach every month older than AUDIT_RETENTION_MONTHS
       pnpm db:audit-retention -- --drop <table> ...   drop months that an earlier run detached and a backup has since captured

Runs as app_migrator over DATABASE_MIGRATION_URL. Never deletes rows; never touches audit_logs_default.`;

/**
 * The two invocations, and every way to get them wrong refused before a connection is opened.
 *
 * `--drop` takes explicit names and only dated ones: the DEFAULT partition does not match the
 * pattern and so cannot be named, and a table of another family is not this command's business.
 * There is deliberately no `--drop-all`: a drop is the one irreversible step of the procedure, and
 * naming the table is how the operator confirms the backup they took was of *that* table.
 */
export const parseRetentionArguments = (argv: readonly string[]): RetentionArguments => {
  // `pnpm db:audit-retention -- --drop x` forwards the separator itself.
  const words = argv.filter((word) => word !== '--');
  const [first, ...rest] = words;

  if (first === undefined) return { mode: 'detach' };

  if (first !== '--drop') {
    return { mode: 'error', message: `unknown argument ${first}\n\n${RETENTION_USAGE}` };
  }

  if (rest.length === 0) {
    return { mode: 'error', message: `--drop needs at least one table name\n\n${RETENTION_USAGE}` };
  }

  const rejected = rest.find((name) => partitionMonth(name) === undefined);

  if (rejected !== undefined) {
    return {
      mode: 'error',
      message: `${rejected} is not a dated audit partition (audit_logs_YYYY_MM); nothing was dropped\n\n${RETENTION_USAGE}`,
    };
  }

  // Each name once: a repeated one passed every pre-check and failed inside the transaction on
  // its second `DROP` with «does not exist» — a sound list, rolled back and reported as broken.
  return { mode: 'drop', tables: [...new Set(rest)] };
};
