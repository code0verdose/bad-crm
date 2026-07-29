import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The upgrade of an **existing** installation — the case the rest of this suite structurally cannot
 * see, because every other file starts against a container that was bootstrapped by the current
 * release and migrated from empty.
 *
 * The defect this file was written for: `20260729120000_auth_owner_and_lookup_functions` names the
 * role `app_auth_definer`, and roles are not created by migrations. They are created by
 * `prisma/sql/00-bootstrap-roles.sql`, which fires through `initdb` only on an empty pgdata volume.
 * An installation that already has data therefore reaches the migration without the role, and
 * `prisma migrate deploy` answers `P3018 … role "app_auth_definer" does not exist`.
 *
 * What makes it worse than a retry: Prisma writes the migration into `_prisma_migrations` with
 * `finished_at IS NULL`, so every later `deploy` — including one run after the roles were fixed —
 * answers `P3009` and applies nothing at all until an operator runs `migrate resolve --rolled-back`
 * by hand. The upgrade of that installation is stuck, not slow.
 *
 * Two containers, because the two halves are different questions:
 *
 *   * `describe('an upgrade that skips the role bootstrap')` reproduces the failure and the stuck
 *     state. It is the evidence for the step `docs/runbooks/upgrade.md` §3 now carries, and it
 *     fails if that failure mode ever stops being real (at which point the step can be revisited).
 *   * `describe('the documented upgrade procedure')` is the regression test: bootstrap first, then
 *     migrate, on a database whose roles were created by an earlier release. This one keeps working
 *     for every role added in the future — which is the whole point, since the defect above is a
 *     class and not an incident.
 *
 * Reproduced by hand first, on pgvector/pgvector:0.8.5-pg16 with Prisma 6.19.3.
 */

const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SQL_DIR = fileURLToPath(new URL('../../../prisma/sql', import.meta.url));
const PRISMA_BIN = fileURLToPath(new URL('../../../node_modules/.bin/prisma', import.meta.url));

const IMAGE = 'pgvector/pgvector:0.8.5-pg16';
const DATABASE = 'bad_crm';
const SUPERUSER = 'bad_crm';

const NEW_MIGRATION = '20260729120000_auth_owner_and_lookup_functions';

/** Throwaway credentials for a container that lives for one test run on an ephemeral port. */
const PASSWORDS = {
  superuser: 'test_superuser',
  migrator: 'test_migrator',
  appUser: 'test_app_user',
  auth: 'test_app_auth',
  backup: 'test_backup_role',
} as const;

/**
 * The roles of an installation created by an **earlier release** — frozen history, not a copy of
 * the shipped bootstrap.
 *
 * This is what `00-bootstrap-roles.sql` produced before EPIC-006 split the authentication role in
 * two: four roles, no `app_auth_definer`. It must never grow. A role added here would model an
 * installation that does not exist, and the file would stop reproducing the one situation it is
 * about — a database whose roles predate the migration being applied to it.
 */
const LEGACY_BOOTSTRAP = `
  CREATE ROLE app_migrator LOGIN NOINHERIT NOBYPASSRLS PASSWORD '${PASSWORDS.migrator}';
  CREATE ROLE app_user     LOGIN NOINHERIT NOBYPASSRLS PASSWORD '${PASSWORDS.appUser}';
  CREATE ROLE app_auth     LOGIN NOINHERIT   BYPASSRLS PASSWORD '${PASSWORDS.auth}';
  CREATE ROLE backup_role  LOGIN NOINHERIT   BYPASSRLS PASSWORD '${PASSWORDS.backup}';

  ALTER DATABASE ${DATABASE} OWNER TO app_migrator;
  REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC;
  GRANT CONNECT ON DATABASE ${DATABASE} TO app_user, app_auth, backup_role;
`;

const LEGACY_SCHEMA_OWNERSHIP = `
  ALTER SCHEMA public OWNER TO app_migrator;
  REVOKE ALL   ON SCHEMA public FROM PUBLIC;
  GRANT  USAGE ON SCHEMA public TO app_user, app_auth, backup_role;
`;

interface Installation {
  readonly container: StartedPostgreSqlContainer;
  readonly urls: { readonly migrator: string; readonly appUser: string };
}

const urlFor = (started: StartedPostgreSqlContainer, role: string, password: string): string =>
  `postgresql://${role}:${password}@${started.getHost()}:${started.getPort()}/${DATABASE}`;

const psql = async (
  started: StartedPostgreSqlContainer,
  args: readonly string[],
): Promise<{ exitCode: number; output: string }> =>
  started.exec(['psql', '-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-U', SUPERUSER, ...args], {
    env: { PGPASSWORD: PASSWORDS.superuser },
  });

/**
 * A container in the state an installation of the previous release is in: the four legacy roles,
 * the extensions, and nothing else. Deliberately **not** mounted into `/docker-entrypoint-initdb.d`
 * — running the current bootstrap here would be modelling a fresh install, which is the case that
 * already works.
 */
const legacyInstallation = async (): Promise<Installation> => {
  const container = await new PostgreSqlContainer(IMAGE)
    .withDatabase(DATABASE)
    .withUsername(SUPERUSER)
    .withPassword(PASSWORDS.superuser)
    .withCopyDirectoriesToContainer([{ source: SQL_DIR, target: '/opt/bad-crm/sql' }])
    .start();

  const legacy = await psql(container, ['-d', 'postgres', '-c', LEGACY_BOOTSTRAP]);
  expect(legacy.exitCode, legacy.output).toBe(0);

  const schema = await psql(container, ['-d', DATABASE, '-c', LEGACY_SCHEMA_OWNERSHIP]);
  expect(schema.exitCode, schema.output).toBe(0);

  const extensions = await psql(container, [
    '-d',
    DATABASE,
    '-f',
    '/opt/bad-crm/sql/initdb/01-extensions.sql',
  ]);
  expect(extensions.exitCode, extensions.output).toBe(0);

  return {
    container,
    urls: {
      migrator: urlFor(container, 'app_migrator', PASSWORDS.migrator),
      appUser: urlFor(container, 'app_user', PASSWORDS.appUser),
    },
  };
};

/** `00-bootstrap-roles.sql` as an operator runs it: the shipped file, through its shipped wrapper. */
const runRoleBootstrap = async (installation: Installation): Promise<void> => {
  const result = await installation.container.exec(
    ['sh', '/opt/bad-crm/sql/initdb/00-bootstrap-roles.sh'],
    {
      env: {
        POSTGRES_USER: SUPERUSER,
        POSTGRES_DB: DATABASE,
        APP_MIGRATOR_PASSWORD: PASSWORDS.migrator,
        APP_USER_PASSWORD: PASSWORDS.appUser,
        APP_AUTH_PASSWORD: PASSWORDS.auth,
        BACKUP_ROLE_PASSWORD: PASSWORDS.backup,
      },
    },
  );

  expect(result.exitCode, result.output).toBe(0);
};

const applyGrants = async (installation: Installation): Promise<void> => {
  const result = await installation.container.exec(
    [
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '--no-psqlrc',
      '-U',
      'app_migrator',
      '-h',
      '127.0.0.1',
      '-d',
      DATABASE,
      '-f',
      '/opt/bad-crm/sql/01-grants.sql',
    ],
    { env: { PGPASSWORD: PASSWORDS.migrator } },
  );

  expect(result.exitCode, result.output).toBe(0);
};

interface PrismaResult {
  readonly ok: boolean;
  readonly output: string;
}

const prisma = async (
  installation: Installation,
  args: readonly string[],
): Promise<PrismaResult> => {
  try {
    const { stdout, stderr } = await execFileAsync(PRISMA_BIN, [...args], {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: installation.urls.appUser,
        DATABASE_MIGRATION_URL: installation.urls.migrator,
      },
    });

    return { ok: true, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message: string };

    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? failure.message}` };
  }
};

/** One query as the schema owner, through `pg` — the catalog is the subject, not the behaviour. */
const asOwner = async <T extends Record<string, unknown>>(
  installation: Installation,
  sql: string,
): Promise<T[]> => {
  const pool = new Pool({ connectionString: installation.urls.migrator, max: 1 });

  try {
    const { rows } = await pool.query<T>(sql);

    return rows;
  } finally {
    await pool.end();
  }
};

describe('an upgrade that skips the role bootstrap', () => {
  let installation: Installation;

  beforeAll(async () => {
    installation = await legacyInstallation();
  });

  afterAll(async () => {
    await installation.container.stop();
  });

  it('fails on the migration that names a role the installation does not have', async () => {
    const deploy = await prisma(installation, ['migrate', 'deploy']);

    expect(deploy.ok, `migrate deploy unexpectedly succeeded:\n${deploy.output}`).toBe(false);
    expect(deploy.output).toContain('P3018');
    expect(deploy.output).toContain('role "app_auth_definer" does not exist');
    expect(deploy.output).toContain(NEW_MIGRATION);
  });

  /**
   * The part that turns a failed command into a stuck installation. `applied_steps_count = 0` says
   * the database was not touched — and Prisma still refuses to move until the row is resolved.
   */
  it('leaves the migration marked failed, with nothing applied', async () => {
    const rows = await asOwner<{
      migration_name: string;
      unfinished: boolean;
      rolled_back_at: Date | null;
      applied_steps_count: number;
    }>(
      installation,
      `SELECT migration_name, finished_at IS NULL AS unfinished, rolled_back_at, applied_steps_count
         FROM _prisma_migrations
        ORDER BY started_at`,
    );

    const failed = rows.find((row) => row.migration_name === NEW_MIGRATION);

    expect(rows.filter((row) => !row.unfinished).length, 'the earlier migrations applied').toBe(
      rows.length - 1,
    );
    expect(failed?.unfinished).toBe(true);
    expect(failed?.rolled_back_at).toBeNull();
    expect(failed?.applied_steps_count).toBe(0);
  });

  it('stays stuck even after the missing role is created — retrying is not the fix', async () => {
    await runRoleBootstrap(installation);

    const retry = await prisma(installation, ['migrate', 'deploy']);

    expect(retry.ok, `migrate deploy unexpectedly succeeded:\n${retry.output}`).toBe(false);
    expect(retry.output).toContain('P3009');
  });

  /**
   * And the way out, which is the one `docs/runbooks/upgrade.md` §6 now names. The row is marked
   * rolled back — honest, because nothing was applied — and the same command then works.
   */
  it('recovers through `migrate resolve --rolled-back`, as §6 prescribes', async () => {
    const resolved = await prisma(installation, [
      'migrate',
      'resolve',
      '--rolled-back',
      NEW_MIGRATION,
    ]);
    expect(resolved.ok, resolved.output).toBe(true);

    const deploy = await prisma(installation, ['migrate', 'deploy']);
    expect(deploy.ok, deploy.output).toBe(true);
  });
});

describe('the documented upgrade procedure — bootstrap, then migrate', () => {
  let installation: Installation;

  beforeAll(async () => {
    installation = await legacyInstallation();
  });

  afterAll(async () => {
    await installation.container.stop();
  });

  /**
   * The regression test. It says nothing about `app_auth_definer` on purpose: what it holds is the
   * *procedure*, so the role added by the next release is covered without anybody editing this file.
   */
  it('applies every migration to a database bootstrapped by an earlier release', async () => {
    await runRoleBootstrap(installation);

    const deploy = await prisma(installation, ['migrate', 'deploy']);

    expect(deploy.ok, deploy.output).toBe(true);
    expect(deploy.output).toContain(NEW_MIGRATION);
  });

  it('ends with the catalog a fresh installation has', async () => {
    await applyGrants(installation);

    const functions = await asOwner<{ signature: string; owner: string; config: string[] | null }>(
      installation,
      `SELECT p.oid::regprocedure::text AS signature,
              pg_get_userbyid(p.proowner)  AS owner,
              p.proconfig                  AS config
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
        ORDER BY signature`,
    );

    expect(functions.map((row) => row.signature)).toEqual([
      'auth_lookup_session(bytea)',
      'auth_lookup_user(citext,text)',
      'auth_lookup_users_by_email(citext)',
    ]);

    for (const row of functions) {
      expect(row.owner, `${row.signature} owner`).toBe('app_auth_definer');
      expect(row.config ?? [], `${row.signature} search_path`).toContain(
        'search_path=pg_catalog, public',
      );
    }
  });
});
