import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Pool } from 'pg';

import { AUDIT_RETENTION_ADVISORY_LOCK_KEY } from '@/infrastructure/bootstrap/audit-retention.constant.js';
import {
  LEAF_PRIVILEGES_SQL,
  POLICIES_SQL,
  ROW_SECURITY_SQL,
} from '@/infrastructure/persistence/prisma/rls-catalog.constant.js';
import { detachedJournalPattern } from '@/infrastructure/persistence/prisma/rls-catalog.util.js';
import { TENANT_TABLES } from '@/infrastructure/persistence/prisma/tenant-tables.constant.js';

import {
  AuditRetentionLockHeldError,
  runAuditRetention,
  type RetentionReport,
} from '../../../scripts/audit-retention.commands.js';

import {
  asMaintenance,
  asTenant,
  closePools,
  createPools,
  insertOrganizationWithOwner,
  reapplyGrants,
  type HarnessPools,
} from './db-harness.util.js';

/**
 * `pnpm db:audit-retention` against the database it will run on — STORY-016-05, the half that
 * cannot be asserted without PostgreSQL.
 *
 * Four properties, each with its positive control:
 *
 * 1. A month older than the threshold is **detached and not dropped**; a month inside it and the
 *    DEFAULT partition are not touched, and the DEFAULT partition is reported on.
 * 2. `app_user` cannot run the procedure at all (the privilege is the mitigation of `T-PLAT-05`,
 *    not the code); `app_migrator` can — otherwise the refusal would be a broken connection.
 * 3. A detached month keeps its isolation: its own `ENABLE`, `FORCE` and both policies, and no
 *    privilege for `app_user` — **including after `01-grants.sql` runs again**, which classifies
 *    tables by the catalog and used to see a detached leaf as an ordinary tenant table.
 * 4. `--drop` removes only a table that is already detached, never an attached partition.
 *
 * And one measurement, printed rather than asserted on: what `DETACH PARTITION` locks and for how
 * long on this image, so the runbook quotes a number and not a belief. The one claim that *is*
 * asserted — `CONCURRENTLY` is refused while a DEFAULT partition exists — is the reason the command
 * takes the exclusive lock and a `lock_timeout` rather than the concurrent form.
 */

let pools: HarnessPools;

const ORG = '00000000-0000-4000-8000-0000000000b5';
const INSUFFICIENT_PRIVILEGE = '42501';
const NOW = new Date('2026-09-06T12:00:00Z');

/** Old enough to be detached at twelve months, inside the horizon at twenty-four. */
const OLD_MONTH = 'audit_logs_2025_03';
/** A second old month, created inside `--drop` to prove the drops are one transaction. */
const OLD_MONTH_2 = 'audit_logs_2025_04';
/** Younger than twelve months: never detached in this file. */
const RECENT_MONTH = 'audit_logs_2025_12';
/** Named for one month, bounded on another — the partition `create_audit_partition` never makes. */
const MISNAMED_MONTH = 'audit_logs_2019_01';
/** Created under a non-UTC session timezone: the bound is offset, the month is still the month. */
const TZ_MONTH = 'audit_logs_2025_05';
/** Named for one month, ranging over two — the next month's rows would go with it. */
const WIDE_MONTH = 'audit_logs_2025_06';
/** Named for a month, open at the bottom — no range to date at all. */
const OPEN_MONTH = 'audit_logs_2018_01';
const FIXTURE_MONTHS = [OLD_MONTH, RECENT_MONTH];
const CLEANUP_TABLES = [
  ...FIXTURE_MONTHS,
  OLD_MONTH_2,
  MISNAMED_MONTH,
  TZ_MONTH,
  WIDE_MONTH,
  OPEN_MONTH,
];

const createMonth = async (date: string): Promise<void> => {
  await asMaintenance(pools.owner, (client) =>
    client.query('SELECT create_audit_partition($1::date)', [date]),
  );
};

const writeEntryAt = async (occurredAt: string, count = 1): Promise<void> => {
  await asTenant(pools.app, ORG, (client) =>
    client.query(
      `INSERT INTO audit_logs
         (organization_id, actor_type, action, resource_type, request_id, severity, occurred_at)
       SELECT $1, 'SYSTEM', 'test.written', 'FIXTURE', 'req-' || gs::text, 'INFO', $2::timestamptz
         FROM generate_series(1, $3::int) AS gs`,
      [ORG, occurredAt, count],
    ),
  );
};

interface RelationState {
  readonly exists: boolean;
  readonly attached: boolean;
}

const relationState = async (name: string): Promise<RelationState> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ relispartition: boolean }>(
      `SELECT c.relispartition
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1`,
      [name],
    );
    const row = rows[0];

    return row === undefined
      ? { exists: false, attached: false }
      : { exists: true, attached: row.relispartition };
  });

const appUserGrantsOn = async (table: string): Promise<string[]> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ privilege_type: string }>(
      `SELECT privilege_type
         FROM information_schema.role_table_grants
        WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name = $1
        ORDER BY privilege_type`,
      [table],
    );

    return rows.map((row) => row.privilege_type);
  });

const retention = (
  pool: Pool,
  options: Partial<Parameters<typeof runAuditRetention>[1]> = {},
): Promise<RetentionReport> =>
  runAuditRetention(pool, { mode: 'detach', now: NOW, retentionMonths: 12, ...options });

beforeAll(async () => {
  pools = createPools();

  await asMaintenance(pools.owner, (client) => insertOrganizationWithOwner(client, ORG));

  for (const month of FIXTURE_MONTHS) {
    await createMonth(`${month.slice('audit_logs_'.length).replace('_', '-')}-01`);
  }

  await writeEntryAt('2025-03-15T10:00:00Z', 100_000);
  await writeEntryAt('2025-12-15T10:00:00Z', 5);
});

afterAll(async () => {
  // Whatever state the assertions left behind: a detached month is an ordinary table now and no
  // `TRUNCATE` of the registry reaches it, so the next file would meet it in the catalog.
  await asMaintenance(pools.owner, async (client) => {
    for (const month of CLEANUP_TABLES) {
      await client.query(`DROP TABLE IF EXISTS ${month}`);
    }
  });

  await closePools(pools);
});

describe('what a detach run does', () => {
  it('CONTROL: both fixture months are attached and the old one holds rows', async () => {
    expect(await relationState(OLD_MONTH)).toEqual({ exists: true, attached: true });
    expect(await relationState(RECENT_MONTH)).toEqual({ exists: true, attached: true });

    const count = await asTenant(
      pools.app,
      ORG,
      async (client) =>
        (
          await client.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM audit_logs
              WHERE occurred_at >= '2025-03-01' AND occurred_at < '2025-04-01'`,
          )
        ).rows[0]?.n,
    );

    expect(count).toBe('100000');
  });

  it('refuses the application role outright, before touching anything', async () => {
    await expect(retention(pools.app)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });

    expect(await relationState(OLD_MONTH)).toEqual({ exists: true, attached: true });
  });

  it('with retention unset detaches nothing and says so', async () => {
    const report = await retention(pools.owner, { retentionMonths: undefined });

    expect(report.detached).toEqual([]);
    expect(report.retentionMonths).toBeUndefined();
    expect(await relationState(OLD_MONTH)).toEqual({ exists: true, attached: true });
  });

  it('detaches the month older than the threshold, keeps the younger one and the DEFAULT, and drops nothing', async () => {
    const started = performance.now();
    const report = await retention(pools.owner);
    const elapsedMs = performance.now() - started;

    expect(report.detached.map((entry) => entry.table)).toEqual([OLD_MONTH]);
    expect(report.kept).toContain(RECENT_MONTH);
    expect(report.kept).not.toContain('audit_logs_default');
    expect(report.failed).toEqual([]);

    expect(await relationState(OLD_MONTH)).toEqual({ exists: true, attached: false });
    expect(await relationState(RECENT_MONTH)).toEqual({ exists: true, attached: true });
    expect(await relationState('audit_logs_default')).toEqual({ exists: true, attached: true });

    // The rows are no longer part of the trail the application reads — and they still exist.
    const visible = await asTenant(
      pools.app,
      ORG,
      async (client) =>
        (
          await client.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM audit_logs
              WHERE occurred_at >= '2025-03-01' AND occurred_at < '2025-04-01'`,
          )
        ).rows[0]?.n,
    );
    const kept = await asMaintenance(
      pools.owner,
      async (client) =>
        (await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${OLD_MONTH}`)).rows[0]
          ?.n,
    );

    expect(visible).toBe('0');
    expect(kept).toBe('100000');

    const detached = report.detached[0];

    expect(detached?.bytes).toBeGreaterThan(0);
    process.stdout.write(
      `[measure] DETACH PARTITION ${OLD_MONTH} (100 000 rows, ${String(detached?.bytes)} bytes): ` +
        `${String(detached?.durationMs.toFixed(1))} ms inside the statement, ` +
        `${elapsedMs.toFixed(1)} ms for the whole run\n`,
    );
  });

  /**
   * Cron and an operator by hand, in the same minute. The first run holds the advisory lock for
   * its duration; the second must say so and touch nothing — not race it for the same `DETACH`
   * and lose with `is not a partition`. Modelled by holding the key the command takes.
   */
  it('refuses to run while another run holds the lock, and touches nothing', async () => {
    await createMonth('2025-04-01');

    const other = await pools.owner.connect();

    try {
      await other.query('SELECT pg_advisory_lock($1::bigint)', [AUDIT_RETENTION_ADVISORY_LOCK_KEY]);

      await expect(retention(pools.owner)).rejects.toBeInstanceOf(AuditRetentionLockHeldError);
      await expect(retention(pools.owner)).rejects.toThrow('another run holds the lock');

      expect(await relationState(OLD_MONTH_2)).toEqual({ exists: true, attached: true });

      await other.query('SELECT pg_advisory_unlock($1::bigint)', [
        AUDIT_RETENTION_ADVISORY_LOCK_KEY,
      ]);
    } finally {
      other.release();
    }

    // CONTROL: with the lock released the same call goes through — and releases its own lock
    // after, or the next test in this file would be the one refused.
    const report = await retention(pools.owner);

    expect(report.detached.map((entry) => entry.table)).toEqual([OLD_MONTH_2]);
    expect(await relationState(OLD_MONTH_2)).toEqual({ exists: true, attached: false });
  });

  /**
   * Retention dates a partition by its name because `create_audit_partition(date)` is the only
   * author of both name and bound. A partition somebody made by hand can carry any bound under any
   * name, and this is the one path to detaching the wrong month. The bound is read back and a
   * mismatch stops the run.
   */
  it('refuses a partition whose bound disagrees with its name, before detaching anything', async () => {
    await asMaintenance(pools.owner, (client) =>
      client.query(
        `CREATE TABLE ${MISNAMED_MONTH} PARTITION OF audit_logs
           FOR VALUES FROM ('2019-02-01') TO ('2019-03-01')`,
      ),
    );

    await expect(retention(pools.owner)).rejects.toThrow(
      `${MISNAMED_MONTH} is named for 2019-01-01 but its partition bound starts at 2019-02-01`,
    );
    expect(await relationState(MISNAMED_MONTH)).toEqual({ exists: true, attached: true });

    await asMaintenance(pools.owner, (client) => client.query(`DROP TABLE ${MISNAMED_MONTH}`));

    // CONTROL: the same run with the impostor gone.
    expect((await retention(pools.owner)).failed).toEqual([]);
  });

  /**
   * `create_audit_partition(date)` writes its bounds as date literals into a `timestamptz` key, so
   * the bound is midnight of the month **in the session's timezone at creation** — an installation
   * with `timezone = 'Europe/Moscow'` in `postgresql.conf` has every partition bounded three hours
   * before UTC midnight. That is still the month the name says; a check that demanded UTC midnight
   * would stop retention on such an installation for good (measured 2026-09-10 by the
   * production-readiness gate). The check tolerates a timezone's worth of offset and refuses only
   * a bound that is a different month altogether.
   */
  it('detaches a month whose partition was created under a non-UTC session timezone', async () => {
    await asMaintenance(pools.owner, async (client) => {
      await client.query("SET LOCAL timezone = 'Europe/Moscow'");
      await client.query('SELECT create_audit_partition($1::date)', ['2025-05-01']);
    });

    // CONTROL: read back in a UTC session (the container's default), the bound really is offset
    // from UTC midnight — otherwise this proves nothing. `pg_get_expr` renders in the session's
    // timezone, which is why it is not read inside the Moscow transaction above.
    const { rows } = await pools.owner.query<{ bound: string }>(
      `SELECT pg_get_expr(c.relpartbound, c.oid) AS bound
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1`,
      [TZ_MONTH],
    );

    expect(rows[0]?.bound).toContain("FROM ('2025-04-30 21:00:00+00')");

    const report = await retention(pools.owner);

    expect(report.failed).toEqual([]);
    expect(report.detached.map((entry) => entry.table)).toEqual([TZ_MONTH]);
    expect(await relationState(TZ_MONTH)).toEqual({ exists: true, attached: false });
  });

  /**
   * The upper bound too. A partition named for June that ranges to August holds July's rows, and
   * July may still be inside the threshold; dating it by name would detach rows younger than the
   * operator asked for. Only a hand-made partition looks like this — and that is the point.
   */
  it('refuses a partition whose upper bound is not the start of the next month', async () => {
    await asMaintenance(pools.owner, (client) =>
      client.query(
        `CREATE TABLE ${WIDE_MONTH} PARTITION OF audit_logs
           FOR VALUES FROM ('2025-06-01') TO ('2025-08-01')`,
      ),
    );

    await expect(retention(pools.owner)).rejects.toThrow(
      `${WIDE_MONTH} is named for 2025-06-01 but its partition bound ends at 2025-08-01`,
    );
    expect(await relationState(WIDE_MONTH)).toEqual({ exists: true, attached: true });

    await asMaintenance(pools.owner, (client) => client.query(`DROP TABLE ${WIDE_MONTH}`));
  });

  /**
   * `MINVALUE` renders without quotes, so the bound regexp does not match and there is no instant
   * to compare: «no range» is the refusal, not a pass — an open-ended partition under a dated name
   * would otherwise be dated by that name alone.
   */
  it('refuses a partition with an open bound under a dated name', async () => {
    await asMaintenance(pools.owner, (client) =>
      client.query(
        `CREATE TABLE ${OPEN_MONTH} PARTITION OF audit_logs
           FOR VALUES FROM (MINVALUE) TO ('2018-02-01')`,
      ),
    );

    await expect(retention(pools.owner)).rejects.toThrow(
      `${OPEN_MONTH} is named for 2018-01-01 but its partition bound starts at no range`,
    );
    expect(await relationState(OPEN_MONTH)).toEqual({ exists: true, attached: true });

    await asMaintenance(pools.owner, (client) => client.query(`DROP TABLE ${OPEN_MONTH}`));
  });

  it('refuses a threshold under a year before opening a connection', async () => {
    await expect(retention(pools.owner, { retentionMonths: 11 })).rejects.toThrow(RangeError);
  });

  it('reports the DEFAULT partition and how many rows sit in it', async () => {
    const report = await retention(pools.owner);

    expect(report.defaultPartition).toEqual({ table: 'audit_logs_default', rows: 0 });
  });

  it('is idempotent: a second run with nothing left to detach changes nothing', async () => {
    const report = await retention(pools.owner);

    expect(report.detached).toEqual([]);
    expect(report.awaitingDrop).toEqual([OLD_MONTH, OLD_MONTH_2, TZ_MONTH]);
  });
});

describe('what a detached month keeps', () => {
  it('its own row security and both policies — they were never inherited, so nothing was lost', async () => {
    const security = await asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{
        table_name: string;
        rls_enabled: boolean;
        rls_forced: boolean;
      }>(ROW_SECURITY_SQL);

      return rows.find((row) => row.table_name === OLD_MONTH);
    });
    const policies = await asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{ table_name: string; policy_name: string }>(
        POLICIES_SQL,
      );

      return rows.filter((row) => row.table_name === OLD_MONTH).map((row) => row.policy_name);
    });

    expect(security).toMatchObject({ rls_enabled: true, rls_forced: true });
    expect(policies.sort()).toEqual(['maintenance_access', 'tenant_isolation']);
  });

  it('nothing for app_user, and the backup can still read it', async () => {
    expect(await appUserGrantsOn(OLD_MONTH)).toEqual([]);

    await expect(
      asTenant(pools.app, ORG, (client) => client.query(`SELECT 1 FROM ${OLD_MONTH} LIMIT 1`)),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });

    const { rows } = await pools.backup.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${OLD_MONTH}`,
    );

    expect(rows[0]?.n).toBe('100000');
  });

  /**
   * The trap this file exists for. `01-grants.sql` classifies by catalog: a table with row
   * security that is not a partition leaf used to fall into «ordinary tenant table» and receive
   * `SELECT, INSERT, UPDATE, DELETE` — so the first `pnpm db:grants` after a detach would have
   * handed the application `DELETE` on a year of evidence. Detached journal months are recognised
   * by name there now, and this is the assertion that keeps it so.
   */
  it('nothing for app_user even after 01-grants.sql runs again', async () => {
    await reapplyGrants(pools.owner);

    expect(await appUserGrantsOn(OLD_MONTH)).toEqual([]);
    // CONTROL: the same run did hand the parent its two privileges, so it was not a no-op.
    expect(await appUserGrantsOn('audit_logs')).toEqual(['INSERT', 'SELECT']);
  });

  /**
   * Check 4c of `docs/security/rls-design.md`, with its positive control. Until 2026-09-10 it
   * filtered on `relispartition` alone, and a detached month — the very table `01-grants.sql`
   * would have mis-classified — fell through it; now it is the same branch the grants file uses.
   * The control is a grant made by hand: 4c must see it, and the repair must remove it.
   */
  it('check 4c sees a privilege on a detached month, and 01-grants.sql takes it away', async () => {
    const pattern = detachedJournalPattern(TENANT_TABLES);
    const leaves = async (): Promise<string[]> =>
      asMaintenance(pools.owner, async (client) => {
        const { rows } = await client.query<{ table_name: string }>(LEAF_PRIVILEGES_SQL, [pattern]);

        return rows.map((row) => row.table_name);
      });

    expect(pattern).toBe('^(audit_logs)_[0-9]{4}_[0-9]{2}$');
    expect(await leaves()).toEqual([]);

    await asMaintenance(pools.owner, (client) =>
      client.query(`GRANT SELECT ON TABLE ${OLD_MONTH} TO app_user`),
    );

    expect(await leaves()).toEqual([OLD_MONTH]);

    await reapplyGrants(pools.owner);

    expect(await leaves()).toEqual([]);
  });
});

describe('--drop', () => {
  it('refuses a table that is still attached, and drops nothing in that run', async () => {
    const report = await retention(pools.owner, {
      mode: 'drop',
      tables: [RECENT_MONTH, OLD_MONTH],
    });

    expect(report.dropped).toEqual([]);
    expect(report.failed).toEqual([
      expect.objectContaining({ table: RECENT_MONTH, reason: 'still attached' }),
    ]);
    expect(await relationState(RECENT_MONTH)).toEqual({ exists: true, attached: true });
    expect(await relationState(OLD_MONTH)).toEqual({ exists: true, attached: false });
  });

  it('refuses a table that does not exist', async () => {
    const report = await retention(pools.owner, { mode: 'drop', tables: ['audit_logs_2001_01'] });

    expect(report.dropped).toEqual([]);
    expect(report.failed).toEqual([
      expect.objectContaining({ table: 'audit_logs_2001_01', reason: 'does not exist' }),
    ]);
  });

  it('refuses the application role', async () => {
    await expect(retention(pools.app, { mode: 'drop', tables: [OLD_MONTH] })).rejects.toMatchObject(
      { code: INSUFFICIENT_PRIVILEGE },
    );

    expect(await relationState(OLD_MONTH)).toEqual({ exists: true, attached: false });
  });

  /**
   * The bound check has to run before the first `DROP`, not after it for the `kept` line of the
   * report: a `DROP` that committed and was then followed by an exception is a removal the cron
   * log never records — and the log is the one place the runbook says the record survives.
   */
  it('refuses before the first DROP when a partition bound disagrees with its name', async () => {
    await asMaintenance(pools.owner, (client) =>
      client.query(
        `CREATE TABLE ${MISNAMED_MONTH} PARTITION OF audit_logs
           FOR VALUES FROM ('2019-02-01') TO ('2019-03-01')`,
      ),
    );

    await expect(retention(pools.owner, { mode: 'drop', tables: [OLD_MONTH] })).rejects.toThrow(
      `${MISNAMED_MONTH} is named for 2019-01-01`,
    );
    expect(await relationState(OLD_MONTH)).toEqual({ exists: true, attached: false });

    await asMaintenance(pools.owner, (client) => client.query(`DROP TABLE ${MISNAMED_MONTH}`));
  });

  /**
   * The drops are one transaction. A reader holding the *second* table — a `pg_dump` of the very
   * month about to be removed — makes the run give up on `lock_timeout`, and the first table,
   * whose `DROP` had already executed inside the transaction, is rolled back with it. Half a list
   * dropped is what the operator would otherwise have to reconcile against their backup.
   */
  it('drops all or nothing: a lock timeout on the second table rolls back the first', async () => {
    const reader = await pools.owner.connect();

    try {
      await reader.query('BEGIN');
      await reader.query("SELECT set_config('app.maintenance', 'on', true)");
      await reader.query(`SELECT count(*) FROM ${OLD_MONTH_2}`);

      const report = await retention(pools.owner, {
        mode: 'drop',
        tables: [OLD_MONTH, OLD_MONTH_2],
        lockTimeoutMs: 300,
      });

      expect(report.dropped).toEqual([]);
      expect(report.failed).toEqual([{ table: OLD_MONTH_2, reason: 'lock timeout' }]);
    } finally {
      await reader.query('ROLLBACK');
      reader.release();
    }

    expect(await relationState(OLD_MONTH)).toEqual({ exists: true, attached: false });
    expect(await relationState(OLD_MONTH_2)).toEqual({ exists: true, attached: false });
  });

  it('drops detached months when asked for them by name', async () => {
    const report = await retention(pools.owner, { mode: 'drop', tables: [OLD_MONTH, OLD_MONTH_2] });

    expect(report.dropped).toEqual([OLD_MONTH, OLD_MONTH_2]);
    expect(report.failed).toEqual([]);
    expect(await relationState(OLD_MONTH)).toEqual({ exists: false, attached: false });
    expect(await relationState(OLD_MONTH_2)).toEqual({ exists: false, attached: false });
  });
});

/**
 * Why the command takes an exclusive lock with a timeout instead of `DETACH … CONCURRENTLY`.
 * Measured rather than remembered: the concurrent form is refused on a parent with a DEFAULT
 * partition, and `audit_logs` has one by design.
 */
describe('DETACH on PostgreSQL 16, measured', () => {
  it('refuses CONCURRENTLY while a DEFAULT partition exists', async () => {
    await createMonth('2025-03-01');

    const client = await pools.owner.connect();

    try {
      // Outside a transaction block, which CONCURRENTLY also requires — so the refusal below is
      // about the DEFAULT partition and not about the block.
      await expect(
        client.query(`ALTER TABLE audit_logs DETACH PARTITION ${OLD_MONTH} CONCURRENTLY`),
      ).rejects.toMatchObject({
        message: 'cannot detach partitions concurrently when a default partition exists',
      });
    } finally {
      client.release();
    }

    expect(await relationState(OLD_MONTH)).toEqual({ exists: true, attached: true });
  });

  it('takes ACCESS EXCLUSIVE on the parent and the leaf for the duration of the statement', async () => {
    const client = await pools.owner.connect();

    try {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE audit_logs DETACH PARTITION ${OLD_MONTH}`);

      const { rows } = await client.query<{ relation: string; mode: string }>(
        `SELECT c.relname AS relation, l.mode
           FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
          WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation'
            AND c.relname IN ('audit_logs', $1) AND l.granted
          ORDER BY c.relname, l.mode`,
        [OLD_MONTH],
      );

      await client.query('ROLLBACK');

      const modes: Record<string, string[]> = {};

      for (const row of rows) (modes[row.relation] ??= []).push(row.mode);

      process.stdout.write(`[measure] locks held by DETACH: ${JSON.stringify(modes)}\n`);

      expect(modes['audit_logs']).toContain('AccessExclusiveLock');
      expect(modes[OLD_MONTH]).toContain('AccessExclusiveLock');
    } finally {
      client.release();
    }

    expect(await relationState(OLD_MONTH)).toEqual({ exists: true, attached: true });
  });

  it('gives up on lock_timeout instead of queueing behind a reader — and the run reports it', async () => {
    const reader = await pools.owner.connect();

    try {
      await reader.query('BEGIN');
      await reader.query("SELECT set_config('app.maintenance', 'on', true)");
      // An open transaction holding ACCESS SHARE on the parent: the shape of a long report, or of
      // a backup in progress.
      await reader.query('SELECT count(*) FROM audit_logs');

      const started = performance.now();
      const report = await retention(pools.owner, { lockTimeoutMs: 300 });
      const elapsedMs = performance.now() - started;

      expect(report.detached).toEqual([]);
      expect(report.failed).toEqual([
        expect.objectContaining({ table: OLD_MONTH, reason: 'lock timeout' }),
      ]);
      expect(elapsedMs).toBeGreaterThanOrEqual(300);
      process.stdout.write(
        `[measure] DETACH behind an open reader gave up after ${elapsedMs.toFixed(0)} ms (lock_timeout 300 ms)\n`,
      );
    } finally {
      await reader.query('ROLLBACK');
      reader.release();
    }

    expect(await relationState(OLD_MONTH)).toEqual({ exists: true, attached: true });
  });
});
