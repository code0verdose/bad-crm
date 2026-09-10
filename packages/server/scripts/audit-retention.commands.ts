import { performance } from 'node:perf_hooks';

import { type Pool, type PoolClient } from 'pg';

import { AUDIT_RETENTION_ADVISORY_LOCK_KEY } from '../src/infrastructure/persistence/prisma/audit-retention.constant.js';

import {
  AUDIT_DEFAULT_PARTITION,
  assertRetentionMonths,
  partitionMonth,
  planRetention,
  retentionCutoff,
} from './audit-retention.util.js';

/**
 * What `pnpm db:audit-retention` executes, against a connection the caller opened.
 *
 * Kept apart from the entrypoint so the integration suite can run the very code the operator runs,
 * on a container of the same image, under both roles — the refusal for `app_user` is a property
 * of the privileges and is proved by trying, not by reading this file.
 *
 * ## Why an exclusive lock with a timeout, and not `CONCURRENTLY`
 *
 * `DETACH PARTITION CONCURRENTLY` would be the obvious choice for a table the application writes
 * to on every privileged action. PostgreSQL 16 refuses it on a parent that has a DEFAULT partition
 * (measured on the stack's own image, `test/integration/db/audit-retention.test.ts`), and
 * `audit_logs_default` is there by design — it is what keeps a forgotten month from failing every
 * transaction of that month. So the plain form it is: `ACCESS EXCLUSIVE` on the parent and on the
 * leaf, for the duration of one catalog change — milliseconds when the lock is free.
 *
 * The lock is the risk, not the work. A detach that queues behind an open reader — a report, a
 * backup — holds every insert of every organization behind *it* until the reader finishes. Hence
 * `lock_timeout`: the statement gives up, the month stays attached, the run reports it and exits
 * non-zero, and the operator tries again rather than the installation stalling.
 *
 * ## One run at a time
 *
 * Cron and an operator by hand can start the command in the same minute, and two runs race for the
 * same `DETACH`: the loser meets `is not a partition`, which this could only report as a broken
 * configuration, and the rest of its plan goes unprocessed. So a run takes a session-level
 * advisory lock first (`pg_try_advisory_lock`, `AUDIT_RETENTION_ADVISORY_LOCK_KEY`) and a second
 * run says `another run holds the lock` and stops before it has touched anything — exit `1`, like
 * every other refusal, and not `2`, because nothing about the installation is wrong.
 *
 * ## What it never does
 *
 * Detach and drop in one run. A detached month is an ordinary table that the nightly `pg_dump`
 * picks up like any other (`backup_role` keeps its `SELECT`); dropping it in the same breath would
 * make retention a way of losing data that looks like tidying up. `--drop` is a separate
 * invocation, takes names, and refuses anything still attached.
 */

export interface RetentionOptions {
  readonly mode: 'detach' | 'drop';
  /** `--drop` only: the detached tables to remove, already validated by name. */
  readonly tables?: readonly string[];
  readonly now: Date;
  /** `undefined` is «retention is off». */
  readonly retentionMonths: number | undefined;
  /**
   * How long one `DETACH` — or the one transaction of `--drop` — waits for its lock. The
   * migrations use 3 s for the same reason and the same statement class, and that is the default
   * here too.
   */
  readonly lockTimeoutMs?: number;
}

export interface DetachedPartition {
  readonly table: string;
  /** `pg_total_relation_size` — the table with its indexes, what the backup will have to hold. */
  readonly bytes: number;
  /** The `DETACH` statement itself, lock wait included. */
  readonly durationMs: number;
}

export interface RetentionFailure {
  readonly table: string;
  readonly reason: 'lock timeout' | 'still attached' | 'does not exist' | 'not a dated partition';
}

/** A second run started while one is in progress; nothing was touched. */
export class AuditRetentionLockHeldError extends Error {
  constructor() {
    super('another run holds the lock');
    this.name = 'AuditRetentionLockHeldError';
  }
}

export interface RetentionReport {
  readonly mode: 'detach' | 'drop';
  readonly retentionMonths: number | undefined;
  /** ISO date of the cutoff, when retention is on. */
  readonly cutoff: string | undefined;
  readonly detached: readonly DetachedPartition[];
  /** Attached partitions this run left alone, DEFAULT excluded. */
  readonly kept: readonly string[];
  /** Dated tables that an earlier run detached and nobody has dropped yet. */
  readonly awaitingDrop: readonly string[];
  readonly dropped: readonly string[];
  readonly failed: readonly RetentionFailure[];
  readonly defaultPartition: { readonly table: string; readonly rows: number };
}

export const DEFAULT_LOCK_TIMEOUT_MS = 3_000;

/** `lock_not_available`: the statement gave up on `lock_timeout`. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * The widest offset from UTC any timezone has (Pacific/Kiritimati, +14:00), in milliseconds.
 *
 * `create_audit_partition(date)` writes its bounds as date literals into a `timestamptz` key, so
 * the bound is midnight of the month **in the session's timezone at creation**: an installation
 * with `timezone = 'Europe/Moscow'` in `postgresql.conf` has every partition bounded three hours
 * before UTC midnight, and it is still the month the name says (measured on the stack's image,
 * `test/integration/db/audit-retention.test.ts`). A bound within a timezone of UTC midnight is
 * that month; a bound for a different month is at least twenty-eight days away.
 */
const BOUND_TOLERANCE_MS = 14 * 60 * 60 * 1000;

/** The instant a bound literal from `pg_get_expr(relpartbound)` denotes, or `NaN` for no range. */
const boundInstant = (epochMs: string | null): number =>
  epochMs === null ? Number.NaN : Number(epochMs);

/** `[month, month + 1)`: what the name promises, in UTC; the tolerance absorbs the timezone. */
const assertBound = (
  table: string,
  edge: 'starts' | 'ends',
  actualMs: number,
  expected: Date,
  named: Date,
): void => {
  if (Math.abs(actualMs - expected.getTime()) <= BOUND_TOLERANCE_MS) return;

  // The full instant, not the date: a bound a few hours off within the same day would otherwise
  // read «named for 2025-01-01 but starts at 2025-01-01», which looks like a contradiction.
  const actual = Number.isNaN(actualMs) ? 'no range' : new Date(actualMs).toISOString();

  throw new Error(
    `${table} is named for ${named.toISOString().slice(0, 10)} but its partition bound ${edge} ` +
      `at ${actual}; refusing to date it by name — create_audit_partition(date) never produces ` +
      'this, check how the partition was created',
  );
};

/**
 * The attached partitions, each dated one checked against both of its bounds.
 *
 * The plan dates a partition by its name, and `create_audit_partition(date)` is the only author of
 * both name and range — but a partition created by hand can carry any range under any name:
 * `audit_logs_2025_03` bounded on 2026 would be retention applied to the wrong month, and
 * `audit_logs_2025_06` ranging to August would take July's rows — younger than the threshold —
 * with it. So both bounds are read back from `relpartbound` as instants, and a bound that is not
 * the named month, to within a timezone (`BOUND_TOLERANCE_MS`), stops the run: it is a broken
 * installation, not a table to skip, and exit `2` says so. Read before anything is detached or
 * dropped, so the refusal never follows a change.
 */
const attachedPartitions = async (client: PoolClient): Promise<string[]> => {
  const { rows } = await client.query<{
    relname: string;
    lower_bound: string | null;
    upper_bound: string | null;
  }>(
    `SELECT c.relname,
            (extract(epoch FROM (bounds.edges[1])::timestamptz) * 1000)::text AS lower_bound,
            (extract(epoch FROM (bounds.edges[2])::timestamptz) * 1000)::text AS upper_bound
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
       JOIN pg_namespace n ON n.oid = p.relnamespace
       LEFT JOIN LATERAL (
         SELECT regexp_match(
                  pg_get_expr(c.relpartbound, c.oid),
                  $$FROM \\('([^']+)'\\) TO \\('([^']+)'\\)$$
                ) AS edges
       ) AS bounds ON true
      WHERE n.nspname = 'public' AND p.relname = 'audit_logs'
      ORDER BY c.relname`,
  );

  for (const row of rows) {
    const month = partitionMonth(row.relname);

    if (month === undefined) continue;

    const nextMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));

    assertBound(row.relname, 'starts', boundInstant(row.lower_bound), month, month);
    assertBound(row.relname, 'ends', boundInstant(row.upper_bound), nextMonth, month);
  }

  return rows.map((row) => row.relname);
};

/** Dated `audit_logs_YYYY_MM` tables of `public` that are no longer partitions of anything. */
const detachedPartitions = async (client: PoolClient): Promise<string[]> => {
  const { rows } = await client.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relispartition
        AND c.relname ~ '^audit_logs_[0-9]{4}_[0-9]{2}$'
      ORDER BY c.relname`,
  );

  return rows.map((row) => row.relname).filter((name) => partitionMonth(name) !== undefined);
};

interface RelationState {
  readonly exists: boolean;
  readonly attached: boolean;
}

const relationState = async (client: PoolClient, table: string): Promise<RelationState> => {
  const { rows } = await client.query<{ relispartition: boolean }>(
    `SELECT c.relispartition
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind = 'r'`,
    [table],
  );
  const row = rows[0];

  return row === undefined
    ? { exists: false, attached: false }
    : { exists: true, attached: row.relispartition };
};

/**
 * Rows in the DEFAULT partition, read in maintenance mode: `FORCE ROW LEVEL SECURITY` applies the
 * policies to the owner too, and without the switch the owner counts zero of everything.
 */
const defaultPartitionRows = async (client: PoolClient): Promise<number> => {
  await client.query('BEGIN');

  try {
    await client.query("SELECT set_config('app.maintenance', 'on', true)");

    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.${AUDIT_DEFAULT_PARTITION}`,
    );

    await client.query('COMMIT');

    return Number(rows[0]?.n ?? '0');
  } catch (error) {
    await client.query('ROLLBACK');

    throw error;
  }
};

const quoted = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/**
 * One month, one transaction: `lock_timeout` is `SET LOCAL` so it cannot leak into whatever the
 * connection does next, and a timeout leaves the month exactly as it was.
 */
const detachOne = async (
  client: PoolClient,
  table: string,
  lockTimeoutMs: number,
): Promise<DetachedPartition | RetentionFailure> => {
  await client.query('BEGIN');

  try {
    await client.query(`SET LOCAL lock_timeout = ${String(Math.trunc(lockTimeoutMs))}`);

    const started = performance.now();

    await client.query(`ALTER TABLE public.audit_logs DETACH PARTITION public.${quoted(table)}`);

    const durationMs = performance.now() - started;
    const { rows } = await client.query<{ bytes: string }>(
      'SELECT pg_total_relation_size($1::regclass)::text AS bytes',
      [`public.${quoted(table)}`],
    );

    await client.query('COMMIT');

    return { table, bytes: Number(rows[0]?.bytes ?? '0'), durationMs };
  } catch (error) {
    await client.query('ROLLBACK');

    if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE) {
      return { table, reason: 'lock timeout' };
    }

    throw error;
  }
};

const isFailure = (result: DetachedPartition | RetentionFailure): result is RetentionFailure =>
  'reason' in result;

const runDetach = async (
  client: PoolClient,
  options: RetentionOptions,
): Promise<Omit<RetentionReport, 'defaultPartition'>> => {
  const attached = await attachedPartitions(client);
  const plan = planRetention({
    now: options.now,
    retentionMonths: options.retentionMonths,
    partitions: attached,
  });
  const results: (DetachedPartition | RetentionFailure)[] = [];

  for (const table of plan.detach) {
    results.push(await detachOne(client, table, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS));
  }

  return {
    mode: 'detach',
    retentionMonths: options.retentionMonths,
    cutoff:
      options.retentionMonths === undefined
        ? undefined
        : retentionCutoff(options.now, options.retentionMonths).toISOString().slice(0, 10),
    detached: results.filter((result): result is DetachedPartition => !isFailure(result)),
    kept: plan.keep,
    awaitingDrop: await detachedPartitions(client),
    dropped: [],
    failed: results.filter(isFailure),
  };
};

/**
 * Every `DROP` of the list in one transaction, behind the same `lock_timeout` as a detach.
 *
 * `DROP TABLE` is transactional in PostgreSQL, so «all or nothing» can be the real thing and not
 * only the pre-check: a list of three where the third is held by an open reader — a `pg_dump` of
 * exactly the table the operator is about to remove — rolls back the first two as well, and the
 * report says `lock timeout` against the table that held it. The operator retries the whole list
 * later rather than reconciling a half-dropped one against their backup. `public.` is explicit
 * here and on every other relation this file names: the name is all this command has, and a
 * `search_path` is not something it should have to trust.
 */
const dropAll = async (
  client: PoolClient,
  tables: readonly string[],
  lockTimeoutMs: number,
): Promise<{ dropped: string[]; failed: RetentionFailure[] }> => {
  await client.query('BEGIN');

  let current: string | undefined;

  try {
    await client.query(`SET LOCAL lock_timeout = ${String(Math.trunc(lockTimeoutMs))}`);

    for (const table of tables) {
      current = table;
      await client.query(`DROP TABLE public.${quoted(table)}`);
    }

    await client.query('COMMIT');

    return { dropped: [...tables], failed: [] };
  } catch (error) {
    await client.query('ROLLBACK');

    if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE && current !== undefined) {
      return { dropped: [], failed: [{ table: current, reason: 'lock timeout' }] };
    }

    throw error;
  }
};

/**
 * All-or-nothing: every name is checked before the first `DROP`, so a list with one attached month
 * in it drops none of the others either. The operator who mistyped one name gets the whole list
 * back, not a partial result to reconcile against their backup. The drops themselves are then one
 * transaction (`dropAll`), so the promise holds past the pre-check too.
 */
const runDrop = async (
  client: PoolClient,
  options: RetentionOptions,
): Promise<Omit<RetentionReport, 'defaultPartition'>> => {
  const tables = options.tables ?? [];
  const failed: RetentionFailure[] = [];
  // Before the first DROP: this is also the bound check, and a refusal must not follow a commit.
  const attached = await attachedPartitions(client);

  for (const table of tables) {
    if (partitionMonth(table) === undefined) {
      failed.push({ table, reason: 'not a dated partition' });
      continue;
    }

    const state = await relationState(client, table);

    if (!state.exists) failed.push({ table, reason: 'does not exist' });
    else if (state.attached) failed.push({ table, reason: 'still attached' });
  }

  const outcome =
    failed.length === 0
      ? await dropAll(client, tables, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)
      : { dropped: [], failed };

  return {
    mode: 'drop',
    retentionMonths: options.retentionMonths,
    cutoff: undefined,
    detached: [],
    kept: attached.filter((name) => name !== AUDIT_DEFAULT_PARTITION),
    awaitingDrop: await detachedPartitions(client),
    dropped: outcome.dropped,
    failed: outcome.failed,
  };
};

/** Session-level: held by this connection until `pg_advisory_unlock` or the connection ends. */
const acquireRunLock = async (client: PoolClient): Promise<void> => {
  const { rows } = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1::bigint) AS locked',
    [AUDIT_RETENTION_ADVISORY_LOCK_KEY],
  );

  if (rows[0]?.locked !== true) throw new AuditRetentionLockHeldError();
};

export const runAuditRetention = async (
  pool: Pool,
  options: RetentionOptions,
): Promise<RetentionReport> => {
  // Before a connection is opened: a threshold the schema would refuse is refused here too, and
  // it is refused with nothing to roll back.
  if (options.mode === 'detach') assertRetentionMonths(options.retentionMonths);

  const client = await pool.connect();

  try {
    await acquireRunLock(client);

    try {
      const outcome =
        options.mode === 'drop' ? await runDrop(client, options) : await runDetach(client, options);

      return {
        ...outcome,
        defaultPartition: {
          table: AUDIT_DEFAULT_PARTITION,
          rows: await defaultPartitionRows(client),
        },
      };
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [
          AUDIT_RETENTION_ADVISORY_LOCK_KEY,
        ]);
      } catch {
        // The session is gone (`terminating connection`, a dropped network): the server released
        // the lock with it, and the error worth reporting is the one that got the run here.
      }
    }
  } finally {
    client.release();
  }
};

/** The report as the operator — and the cron log — reads it. */
export const renderRetentionReport = (report: RetentionReport): string => {
  const lines: string[] = [];

  if (report.mode === 'detach') {
    lines.push(
      report.retentionMonths === undefined
        ? 'audit retention: AUDIT_RETENTION_MONTHS is not set — retention is off, nothing detached'
        : `audit retention: ${String(report.retentionMonths)} months, cutoff ${String(report.cutoff)}`,
    );

    for (const entry of report.detached) {
      lines.push(
        `  detached ${entry.table} (${String(entry.bytes)} bytes, ${entry.durationMs.toFixed(0)} ms) — back it up, then drop it`,
      );
    }

    lines.push(`  kept ${String(report.kept.length)} attached partition(s)`);
  } else {
    for (const table of report.dropped) lines.push(`  dropped ${table}`);
  }

  for (const failure of report.failed) lines.push(`  FAILED ${failure.table}: ${failure.reason}`);

  if (report.awaitingDrop.length > 0) {
    lines.push(
      `  awaiting drop: ${report.awaitingDrop.join(', ')} — detached earlier; ` +
        'confirm the backup, then pnpm db:audit-retention -- --drop <table>',
    );
  }

  lines.push(
    report.defaultPartition.rows === 0
      ? `  ${report.defaultPartition.table}: empty`
      : `  WARNING ${report.defaultPartition.table} holds ${String(report.defaultPartition.rows)} row(s): ` +
          'a month had no partition when they were written — run pnpm db:audit-partitions and move them ' +
          '(docs/runbooks/audit-log.md); retention never touches this partition',
  );

  return `${lines.join('\n')}\n`;
};
