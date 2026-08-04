import { fileURLToPath } from 'node:url';

import { type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { databaseReadinessProbe } from '@/infrastructure/persistence/prisma/database-readiness.adapter.js';
import { migrationReadinessProbe } from '@/infrastructure/persistence/prisma/migration-readiness.adapter.js';
import { createPrismaClient } from '@/infrastructure/persistence/prisma/prisma.client.js';
import { shippedMigrationNames } from '@/infrastructure/persistence/prisma/shipped-migrations.util.js';

/**
 * The readiness probes, run **as the role the server runs as**, against a migrated database.
 *
 * This file exists because of a defect it would have caught on the day it was written. The
 * migration probe is covered by unit tests, and they pass a fake client that answers with rows —
 * so they assert the comparison and cannot see the question that comes before it: *may this role
 * read `_prisma_migrations` at all?* It could not. `01-grants.sql` granted the table to
 * `backup_role` and to nobody else, deliberately («invisible to the application»), so on a
 * correctly installed, fully migrated installation the query failed with `permission denied` and
 * `/ready` answered `migrations: down` — for ever. An orchestrator would never route traffic to a
 * healthy instance, and no test in the repository disagreed.
 *
 * Found by hand, by curling `/ready` on a local stack whose migrations were up to date
 * (2026-08-05). The lesson is the file: a probe must be exercised through the connection the
 * process actually uses, because the interesting failures live in the privileges of that
 * connection, not in the logic above them.
 */

const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: (): LoggerPort => silentLogger,
};

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../../prisma/migrations', import.meta.url));

let asApplication: PrismaClient;

beforeAll(() => {
  asApplication = createPrismaClient({ url: inject('databaseUrls').appUser, logger: silentLogger });
});

afterAll(async () => {
  await asApplication.$disconnect();
});

describe('the readiness probes as app_user', () => {
  it('reports the database up', async () => {
    await expect(databaseReadinessProbe(asApplication).check()).resolves.toMatchObject({
      status: 'up',
    });
  });

  /**
   * The assertion the defect failed. `up` here means two things at once — every shipped migration
   * is applied, **and** the application role was allowed to find that out.
   */
  it('reports the migrations up on a fully migrated database', async () => {
    const probe = migrationReadinessProbe(
      asApplication,
      shippedMigrationNames(MIGRATIONS_DIRECTORY),
    );

    await expect(probe.check()).resolves.toEqual({ status: 'up' });
  });

  /**
   * CONTROL: the probe is comparing against a non-empty set of shipped migrations. Against an empty
   * expectation every database is «migrated», and the case above would pass on a table the role
   * still cannot read.
   */
  it('CONTROL: has migrations to check', () => {
    expect(shippedMigrationNames(MIGRATIONS_DIRECTORY).length).toBeGreaterThan(0);
  });

  /**
   * The other direction, and the reason the grant is `SELECT` and nothing else: an application that
   * could write this table could mark a failed migration as finished — hiding the state from the
   * probe whose whole job is to notice it.
   */
  it('cannot write to the migrations table', async () => {
    await expect(
      asApplication.$executeRawUnsafe(
        "UPDATE _prisma_migrations SET finished_at = now() WHERE migration_name = 'nothing'",
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
