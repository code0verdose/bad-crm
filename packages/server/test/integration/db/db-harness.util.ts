import { randomUUID } from 'node:crypto';
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
  /**
   * `app_auth`: the authentication path.
   *
   * BYPASSRLS and *no table privileges at all* — the two together are what make the path narrow.
   * Assertions about it are therefore about what it cannot reach, not only about what it can.
   */
  readonly auth: Pool;
  /**
   * The cluster superuser.
   *
   * Used by one test, and only to *break* things the way a restore does — moving a function back to
   * app_migrator is something no application role may do, which is the point.
   */
  readonly superuser: Pool;
}

export const createPools = (): HarnessPools => {
  const urls = inject('databaseUrls');

  return {
    app: new Pool({ connectionString: urls.appUser, max: 4 }),
    owner: new Pool({ connectionString: urls.migrator, max: 4 }),
    backup: new Pool({ connectionString: urls.backup, max: 2 }),
    auth: new Pool({ connectionString: urls.auth, max: 2 }),
    superuser: new Pool({ connectionString: urls.superuser, max: 2 }),
  };
};

export const closePools = async (pools: HarnessPools): Promise<void> => {
  await Promise.all([
    pools.app.end(),
    pools.owner.end(),
    pools.backup.end(),
    pools.auth.end(),
    pools.superuser.end(),
  ]);
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
/**
 * A tenant root and the owner it cannot exist without, in one statement.
 *
 * `organizations.owner_id` is NOT NULL and references a user of that same organization, while the user
 * references the organization back, so neither insert can go first. Foreign keys are `AFTER ROW`
 * triggers evaluated when the statement finishes, and by then both rows are there — which is exactly
 * how `OrganizationRepositoryPort.createWithOwner` writes them in the product.
 *
 * Shared rather than repeated per suite: six fixtures used to write the organization alone, and each
 * of them would otherwise have to learn this trick separately — and get it right separately.
 */
export const insertOrganizationWithOwner = async (
  client: Pool | PoolClient,
  organizationId: string,
  options: { slug?: string; name?: string; ownerEmail?: string } = {},
): Promise<{ ownerId: string }> => {
  const ownerId = randomUUID();
  const suffix = randomUUID().slice(0, 8);

  await client.query(
    `WITH created_organization AS (
       INSERT INTO organizations (id, owner_id, slug, name, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, now())
       RETURNING id
     )
     INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
     VALUES ($2::uuid, $1::uuid, $5, 'placeholder-not-a-credential', 'ACTIVE', now())`,
    [
      organizationId,
      ownerId,
      options.slug ?? `org-${organizationId.slice(0, 8)}-${suffix}`,
      options.name ?? 'Acme',
      options.ownerEmail ?? `owner-${ownerId.slice(0, 8)}@example.test`,
    ],
  );

  return { ownerId };
};

export const truncateAll = async (owner: Pool): Promise<void> => {
  const tables = Object.keys(TENANT_TABLES)
    .map((table) => `public."${table}"`)
    .join(', ');

  await owner.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
};

/**
 * The shipped `01-grants.sql`, minus its single psql meta-command.
 *
 * `\set ON_ERROR_STOP on` is psql's own error handling and `pg` cannot send it; this client throws
 * on the first error anyway. Nothing else in the file is psql-specific — if that ever changes, this
 * helper stops matching the shipped file and the tests using it start failing, which is right.
 */
const grantsScript = (): string =>
  readFileSync(GRANTS_SQL, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');

/**
 * Re-applies `01-grants.sql` from a test process, to prove that a second run changes nothing.
 *
 * The authoritative run happens in `globalSetup`, through psql inside the container, on the file as
 * it ships.
 */
export const reapplyGrants = async (owner: Pool): Promise<void> => {
  await owner.query(grantsScript());
};

/**
 * The same run, with the server's `NOTICE` and `WARNING` messages kept.
 *
 * `01-grants.sql` reports two things it cannot report any other way: the summary of what it granted,
 * and — since the `search_path` guard stopped refusing objects an operator cannot fix — the
 * extension functions it had to let past. A warning nobody can assert on is a warning that quietly
 * stops being emitted, so the messages are collected rather than left to psql's stderr.
 *
 * A dedicated client, because `notice` is an event on the connection: taken from the pool for the
 * duration of the run and released with its listener removed.
 */
export const reapplyGrantsCollectingNotices = async (owner: Pool): Promise<string[]> => {
  const client = await owner.connect();
  const messages: string[] = [];
  const collect = (notice: { readonly message: string | undefined }): void => {
    if (notice.message !== undefined) messages.push(notice.message);
  };

  client.on('notice', collect);

  try {
    await client.query(grantsScript());
  } finally {
    client.off('notice', collect);
    client.release();
  }

  return messages;
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
