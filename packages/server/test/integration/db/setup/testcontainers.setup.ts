import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type TestProject } from 'vitest/node';

/**
 * One PostgreSQL container for the whole integration run.
 *
 * `globalSetup` and not a `beforeAll` per file: starting a container, running the role bootstrap
 * and applying the migrations takes seconds, and doing that per file turns a suite that grows into
 * a suite nobody runs. Files share the container and clean up with `TRUNCATE ... RESTART IDENTITY
 * CASCADE` between tests (rules/testing.mdc, 11), which is also why `vitest.integration.config.ts`
 * keeps `fileParallelism` off: two files truncating the same tables concurrently would fail each
 * other for reasons unrelated to what they assert.
 *
 * The image is the one `docker-compose.yml` runs, pinned to the same tag. A test against
 * `postgres:16` would be a test against a database this project never starts — pgvector's image is
 * a different build, and the extensions of `01-extensions.sql` only exist there.
 *
 * The database is prepared exactly the way an installation is, through the artefacts that ship:
 *   1. `prisma/sql/initdb/**` mounted where the entrypoint runs it — roles, ownership, extensions;
 *   2. `prisma migrate deploy` as `app_migrator`, over DATABASE_MIGRATION_URL;
 *   3. `prisma/sql/01-grants.sql`, the source of truth for privileges, run as `app_migrator`.
 * Skipping step 3 would leave the suite running as the owner and blind to every privilege mistake,
 * which is the one failure mode of a grant that nothing else catches.
 */

const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const SQL_DIR = fileURLToPath(new URL('../../../../prisma/sql', import.meta.url));
const INITDB_DIR = fileURLToPath(new URL('../../../../prisma/sql/initdb', import.meta.url));
const PRISMA_BIN = fileURLToPath(new URL('../../../../node_modules/.bin/prisma', import.meta.url));

/** Same image tag as `docker-compose.yml`; the two are meant to drift together or not at all. */
const IMAGE = 'pgvector/pgvector:0.8.5-pg16';

const DATABASE = 'bad_crm';
const SUPERUSER = 'bad_crm';

/**
 * Throwaway credentials for a container that lives for one test run, is published on an ephemeral
 * port and is deleted afterwards. They are not secrets and are deliberately not read from `.env`:
 * a suite that needs a developer's environment file is a suite that fails differently on CI.
 */
const PASSWORDS = {
  superuser: 'test_superuser',
  migrator: 'test_migrator',
  appUser: 'test_app_user',
  auth: 'test_app_auth',
  backup: 'test_backup_role',
} as const;

export interface TestDatabaseUrls {
  readonly superuser: string;
  readonly migrator: string;
  readonly appUser: string;
  /** `app_auth`: BYPASSRLS, no table privileges, three SECURITY DEFINER functions and nothing else. */
  readonly auth: string;
  readonly backup: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrls: TestDatabaseUrls;
  }
}

const urlFor = (host: string, port: number, role: string, password: string): string =>
  `postgresql://${role}:${password}@${host}:${port}/${DATABASE}`;

let container: StartedPostgreSqlContainer | undefined;

export default async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer(IMAGE)
    .withDatabase(DATABASE)
    .withUsername(SUPERUSER)
    .withPassword(PASSWORDS.superuser)
    .withEnvironment({
      APP_MIGRATOR_PASSWORD: PASSWORDS.migrator,
      APP_USER_PASSWORD: PASSWORDS.appUser,
      APP_AUTH_PASSWORD: PASSWORDS.auth,
      BACKUP_ROLE_PASSWORD: PASSWORDS.backup,
    })
    .withCopyDirectoriesToContainer([
      { source: INITDB_DIR, target: '/docker-entrypoint-initdb.d' },
      { source: SQL_DIR, target: '/opt/bad-crm/sql' },
    ])
    .start();

  const host = container.getHost();
  const port = container.getPort();

  const urls: TestDatabaseUrls = {
    superuser: urlFor(host, port, SUPERUSER, PASSWORDS.superuser),
    migrator: urlFor(host, port, 'app_migrator', PASSWORDS.migrator),
    appUser: urlFor(host, port, 'app_user', PASSWORDS.appUser),
    auth: urlFor(host, port, 'app_auth', PASSWORDS.auth),
    backup: urlFor(host, port, 'backup_role', PASSWORDS.backup),
  };

  await execFileAsync(PRISMA_BIN, ['migrate', 'deploy'], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: urls.appUser,
      DATABASE_MIGRATION_URL: urls.migrator,
    },
  });

  await applyGrants(container);

  project.provide('databaseUrls', urls);
}

/**
 * Runs `01-grants.sql` through psql inside the container, unmodified.
 *
 * Through psql and not through `pg` because the file is a psql script — it opens with
 * `\set ON_ERROR_STOP on`, and a client that cannot read meta-commands would need a stripped copy.
 * A stripped copy is a second artefact that can drift from the one an operator actually runs, and
 * the whole value of this step is that it exercises the shipped file.
 */
export const applyGrants = async (started: StartedPostgreSqlContainer): Promise<void> => {
  const result = await started.exec(
    [
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '--no-psqlrc',
      '-U',
      'app_migrator',
      '-d',
      DATABASE,
      '-f',
      '/opt/bad-crm/sql/01-grants.sql',
    ],
    { env: { PGPASSWORD: PASSWORDS.migrator } },
  );

  if (result.exitCode !== 0) {
    throw new Error(`01-grants.sql failed with exit code ${result.exitCode}:\n${result.output}`);
  }
};

export async function teardown(): Promise<void> {
  await container?.stop();
}
