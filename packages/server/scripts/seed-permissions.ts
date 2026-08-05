import { fileURLToPath } from 'node:url';

import { loadEnv } from '../src/infrastructure/bootstrap/load-env.util.js';
import { createPrismaClient } from '../src/infrastructure/persistence/prisma/prisma.client.js';
import { type LoggerPort } from '../src/application/platform/ports/logger.port.js';

import { planCatalog, renderCatalogPlan } from './seed-permissions.util.js';

/**
 * `pnpm db:seed:permissions` — brings the catalogue table in line with the catalogue in the code.
 *
 * Runs on install and on every upgrade, next to `pnpm db:grants`: the code is the source of truth
 * for which permissions exist, and an installation whose table lags behind the build cannot resolve
 * a key the build checks.
 *
 * Uses the migration connection, not the application one: `app_user` may read this table and must
 * never write it (`prisma/sql/01-grants.sql`) — an application that could write the catalogue could
 * grant itself a permission.
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
  const existing = await prisma.permission.findMany({ select: { key: true, deprecatedAt: true } });
  const plan = planCatalog(existing);

  await prisma.$transaction([
    ...plan.upsert.map((permission) =>
      prisma.permission.upsert({
        where: { key: permission.key },
        create: permission,
        update: { ...permission, deprecatedAt: null },
      }),
    ),
    prisma.permission.updateMany({
      where: { key: { in: [...plan.deprecate] } },
      data: { deprecatedAt: new Date() },
    }),
  ]);

  process.stdout.write(`${renderCatalogPlan(plan)}\n`);
} catch (error) {
  process.stderr.write(
    `db:seed:permissions could not run: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
