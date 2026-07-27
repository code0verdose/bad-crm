import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Pool, type PoolClient } from 'pg';
import { inject } from 'vitest';

import { TENANT_TABLES } from '@/infrastructure/persistence/prisma/tenant-tables.constant.js';

/**
 * Connections and helpers shared by the database integration suite.
 *
 * The isolation tests talk to PostgreSQL through `pg`, not through Prisma. That is the whole point:
 * what is under test is the database — its policies, its grants — and a correct `withTenant` would
 * mask a missing policy by always sending the context anyway (rules/tenancy-rls.mdc, 16).
 */

const GRANTS_SQL = fileURLToPath(new URL('../../../prisma/sql/01-grants.sql', import.meta.url));

export interface HarnessPools {
  /** `app_user`: subject to RLS. Everything an assertion is made about runs here. */
  readonly app: Pool;
  /** `app_migrator`: owner, used only to seed and to observe what the app is not allowed to see. */
  readonly owner: Pool;
  /** `backup_role`: BYPASSRLS, read-only — the role `pg_dump` uses. */
  readonly backup: Pool;
}

export const createPools = (): HarnessPools => {
  const urls = inject('databaseUrls');

  return {
    app: new Pool({ connectionString: urls.appUser, max: 4 }),
    owner: new Pool({ connectionString: urls.migrator, max: 4 }),
    backup: new Pool({ connectionString: urls.backup, max: 2 }),
  };
};

export const closePools = async (pools: HarnessPools): Promise<void> => {
  await Promise.all([pools.app.end(), pools.owner.end(), pools.backup.end()]);
};

const inTransaction = async <T>(
  pool: Pool,
  before: (client: PoolClient) => Promise<void>,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await before(client);
    const result = await fn(client);
    await client.query('COMMIT');

    return result;
  } catch (error) {
    await client.query('ROLLBACK');

    throw error;
  } finally {
    client.release();
  }
};

/**
 * Runs `fn` the way the application runs everything: one transaction, the tenant pinned to it with
 * `set_config(..., is_local => true)`, the value bound as a parameter.
 */
export const asTenant = async <T>(
  pool: Pool,
  organizationId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> =>
  inTransaction(
    pool,
    async (client) => {
      await client.query('SELECT set_config($1, $2, true)', [
        'app.organization_id',
        organizationId,
      ]);
    },
    fn,
  );

/**
 * Runs `fn` as the table owner in maintenance mode — the only way the owner sees anything at all,
 * because `FORCE ROW LEVEL SECURITY` applies the policies to it too. Used to seed fixtures and to
 * count what the application is not allowed to count.
 */
export const asMaintenance = async <T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> =>
  inTransaction(
    pool,
    async (client) => {
      await client.query('SELECT set_config($1, $2, true)', ['app.maintenance', 'on']);
    },
    fn,
  );

/**
 * `TRUNCATE ... RESTART IDENTITY CASCADE` between tests rather than a fresh container
 * (rules/testing.mdc, 11). Runs as the owner: TRUNCATE is not subject to row-level security and is
 * granted to nobody else, on purpose — one statement would empty a table for every organization.
 */
export const truncateAll = async (owner: Pool): Promise<void> => {
  const tables = Object.keys(TENANT_TABLES)
    .map((table) => `public."${table}"`)
    .join(', ');

  await owner.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
};

/**
 * Re-applies `01-grants.sql` from a test process, to prove that a second run changes nothing.
 *
 * The authoritative run happens in `globalSetup`, through psql inside the container, on the file as
 * it ships. Here the single psql meta-command (`\set ON_ERROR_STOP on`) is dropped so `pg` can send
 * the rest: `ON_ERROR_STOP` is psql's own error handling, and this client already throws on the
 * first error. Nothing else in the file is psql-specific — if that ever changes, this helper stops
 * matching the shipped file and the test that uses it starts failing, which is the right outcome.
 */
export const reapplyGrants = async (owner: Pool): Promise<void> => {
  const sql = readFileSync(GRANTS_SQL, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');

  await owner.query(sql);
};

/** Table-level privileges `app_user` actually holds, straight out of the catalog. */
export const appUserPrivileges = async (owner: Pool, table: string): Promise<string[]> => {
  const { rows } = await owner.query<{ privilege_type: string }>(
    `SELECT privilege_type
       FROM information_schema.table_privileges
      WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name = $1
      ORDER BY privilege_type`,
    [table],
  );

  return rows.map((row) => row.privilege_type);
};
