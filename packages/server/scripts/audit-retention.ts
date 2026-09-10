import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import {
  AuditRetentionLockHeldError,
  renderRetentionReport,
  runAuditRetention,
} from './audit-retention.commands.js';
import { parseRetentionArguments } from './audit-retention.util.js';
import { ownerRoleHint, readScriptEnv } from './maintenance-script.util.js';

/**
 * `pnpm db:audit-retention` — detaches the months of the audit trail that are older than
 * `AUDIT_RETENTION_MONTHS`, and, asked by name, drops the ones an earlier run detached.
 *
 * ## Why a maintenance command and not a background job
 *
 * The same reason `pnpm db:audit-partitions` is one. `DETACH` and `DROP` are DDL on a table the
 * application does not own — `app_user` holds `INSERT` and `SELECT` on `audit_logs` and nothing on
 * any leaf, and *that* is the whole of the append-only guarantee (`T-PLAT-05`): a process that
 * could remove a month of the trail would be a process an attacker inside it could use to remove
 * the month they are in. So this runs as `app_migrator`, over `DATABASE_MIGRATION_URL`, from the
 * host's cron by the runbook — and there is no scheduler in the product to hang it on anyway
 * (`docs/runbooks/audit-log.md`).
 *
 * ## Two steps, never one
 *
 * A detached month is an ordinary table: still isolated by its own policies, still readable by
 * `backup_role`, still in the next `pg_dump`. Dropping it is a second invocation with the table's
 * name, after the operator has confirmed a backup holds it. The command that detached and dropped
 * in one run would be a command whose failure mode is silent data loss.
 *
 * Exit codes: `0` done; `1` something was refused or timed out and the report says which — or
 * another run holds the advisory lock; `2` bad arguments or configuration, including an
 * environment the schema refuses.
 */

try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch {
  // No file: a container passes the environment directly, and that is the normal case there.
}

const arguments_ = parseRetentionArguments(process.argv.slice(2));

if (arguments_.mode === 'error') {
  process.stderr.write(`${arguments_.message}\n`);
  process.exit(2);
}

/** `scripts/**` is tooling: the ban on reading `process.env` guards `src/**`, not this. */
const environment = readScriptEnv('db:audit-retention', process.env);

if (!environment.ok) {
  process.stderr.write(`${environment.message}\n`);
  process.exit(2);
}

const { env } = environment;
const migrationUrlSet = env.DATABASE_MIGRATION_URL !== undefined;
const pool = new Pool({ connectionString: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL, max: 1 });

try {
  const report = await runAuditRetention(pool, {
    mode: arguments_.mode,
    ...(arguments_.mode === 'drop' ? { tables: arguments_.tables } : {}),
    now: new Date(),
    retentionMonths: env.AUDIT_RETENTION_MONTHS,
  });

  process.stdout.write(renderRetentionReport(report));

  if (report.failed.length > 0) process.exitCode = 1;
} catch (error) {
  if (error instanceof AuditRetentionLockHeldError) {
    process.stderr.write(`db:audit-retention: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    const hint = ownerRoleHint(error, { migrationUrlSet });

    process.stderr.write(
      `db:audit-retention could not run: ${error instanceof Error ? error.message : String(error)}\n` +
        (hint === undefined ? '' : `${hint}\n`),
    );
    process.exitCode = 2;
  }
} finally {
  await pool.end();
}
