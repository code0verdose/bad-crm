import { fileURLToPath } from 'node:url';

import { loadEnv } from '../src/infrastructure/bootstrap/load-env.util.js';
import { createPrismaClient } from '../src/infrastructure/persistence/prisma/prisma.client.js';
import { type LoggerPort } from '../src/application/platform/ports/logger.port.js';

import { monthsToEnsure, partitionDate } from './audit-partitions.util.js';

/**
 * `pnpm db:audit-partitions` — makes sure the audit trail has somewhere to write, this month and the
 * two after it.
 *
 * ## Why a maintenance command and not a background job
 *
 * STORY-016-01 asks for `ensure-audit-partitions.job.ts`, in the application. It cannot live there:
 * creating a partition is `CREATE TABLE`, and the application connects as `app_user`, which owns
 * nothing and may not create anything — deliberately, because a role that could create a table could
 * create one without a policy. The same privilege boundary the story relies on for `DETACH`
 * (acceptance 8) applies to the other end of a partition's life.
 *
 * So this runs as `app_migrator`, next to `pnpm db:migrate` and `pnpm db:grants`, and the upgrade
 * runbook calls it. A scheduled run arrives with the queue infrastructure of EPIC-021, as a job that
 * uses the migration connection — the horizon of two months is what makes a missed run survivable
 * until then.
 *
 * Idempotent: `create_audit_partition` returns the existing name when the month is already there, so
 * running it twice a day costs three catalogue lookups.
 */

try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch {
  // No file: a container passes the environment directly, and that is the normal case there.
}

const silent: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: (): LoggerPort => silent,
};

/** `scripts/**` is tooling: the ban on reading `process.env` guards `src/**`, not this. */
const env = loadEnv(process.env);
const prisma = createPrismaClient({
  url: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL,
  logger: silent,
});

try {
  const created: string[] = [];

  for (const month of monthsToEnsure(new Date())) {
    const rows = await prisma.$queryRawUnsafe<{ create_audit_partition: string }[]>(
      'SELECT create_audit_partition($1::date)',
      partitionDate(month),
    );

    created.push(rows[0]?.create_audit_partition ?? partitionDate(month));
  }

  process.stdout.write(`audit partitions ready: ${created.join(', ')}\n`);
} catch (error) {
  process.stderr.write(
    `db:audit-partitions could not run: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
