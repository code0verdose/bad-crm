import { performance } from 'node:perf_hooks';

import { type Pool, type PoolClient } from 'pg';

import {
  AUDIT_DEFAULT_PARTITION,
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
   * How long one `DETACH` waits for its lock. The migrations use 3 s for the same reason and the
   * same statement class, and that is the default here too.
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

const attachedPartitions = async (client: PoolClient): Promise<string[]> => {
  const { rows } = await client.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
       JOIN pg_namespace n ON n.oid = p.relnamespace
      WHERE n.nspname = 'public' AND p.relname = 'audit_logs'
      ORDER BY c.relname`,
  );

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
      `SELECT count(*)::text AS n FROM ${AUDIT_DEFAULT_PARTITION}`,
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

    await client.query(`ALTER TABLE audit_logs DETACH PARTITION ${quoted(table)}`);

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
 * All-or-nothing: every name is checked before the first `DROP`, so a list with one attached month
 * in it drops none of the others either. The operator who mistyped one name gets the whole list
 * back, not a partial result to reconcile against their backup.
 */
const runDrop = async (
  client: PoolClient,
  options: RetentionOptions,
): Promise<Omit<RetentionReport, 'defaultPartition'>> => {
  const tables = options.tables ?? [];
  const failed: RetentionFailure[] = [];

  for (const table of tables) {
    if (partitionMonth(table) === undefined) {
      failed.push({ table, reason: 'not a dated partition' });
      continue;
    }

    const state = await relationState(client, table);

    if (!state.exists) failed.push({ table, reason: 'does not exist' });
    else if (state.attached) failed.push({ table, reason: 'still attached' });
  }

  const dropped: string[] = [];

  if (failed.length === 0) {
    for (const table of tables) {
      await client.query(`DROP TABLE ${quoted(table)}`);
      dropped.push(table);
    }
  }

  return {
    mode: 'drop',
    retentionMonths: options.retentionMonths,
    cutoff: undefined,
    detached: [],
    kept: (await attachedPartitions(client)).filter((name) => name !== AUDIT_DEFAULT_PARTITION),
    awaitingDrop: await detachedPartitions(client),
    dropped,
    failed,
  };
};

export const runAuditRetention = async (
  pool: Pool,
  options: RetentionOptions,
): Promise<RetentionReport> => {
  const client = await pool.connect();

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
