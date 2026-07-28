import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  CANONICAL_MAINTENANCE_PREDICATE,
  CANONICAL_TENANT_PREDICATE,
} from '@/infrastructure/persistence/prisma/rls-catalog.constant.js';
import {
  readRlsCatalog,
  rlsCatalogViolations,
  type RlsCatalogFacts,
  type RlsPolicyFacts,
} from '@/infrastructure/persistence/prisma/rls-catalog.util.js';
import { TENANT_TABLES } from '@/infrastructure/persistence/prisma/tenant-tables.constant.js';

import {
  appUserPrivileges,
  asMaintenance,
  closePools,
  createPools,
  reapplyGrants,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';
import { ROW_FACTORIES } from './row-factories.util.js';

/**
 * What the migration produced, read back out of the catalog.
 *
 * The isolation suite next door proves the policies behave; this one proves they exist in the shape
 * the specification requires — including the parts no query can observe from the outside, such as
 * `FORCE ROW LEVEL SECURITY` or a `GRANT SELECT` for `backup_role` whose absence only shows up the
 * day a backup is restored.
 */

const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PRISMA_BIN = fileURLToPath(new URL('../../../node_modules/.bin/prisma', import.meta.url));

const REQUIRED_EXTENSIONS = ['citext', 'pg_trgm', 'pgcrypto', 'vector'];

let pools: HarnessPools;

/**
 * The catalog as `pnpm check:rls` reads it.
 *
 * The queries and the canonical predicate come from
 * `src/infrastructure/persistence/prisma/rls-catalog.constant.ts` — the same module the script
 * imports — because a policy template written out in two places drifts the first time it changes.
 * The assertions below stay per table on purpose: the script answers "is this database correct",
 * this suite answers "which table of the migration is wrong", and the second question is the one
 * being debugged at the moment a migration is written.
 */
let catalog: RlsCatalogFacts;

beforeAll(async () => {
  pools = createPools();
  catalog = await readRlsCatalog(async (sql) => (await pools.owner.query(sql)).rows);
});

afterAll(async () => {
  await closePools(pools);
});

describe('prisma migrate deploy', () => {
  it('recorded the migration as applied, with no rolled-back step', async () => {
    const { rows } = await pools.owner.query<{
      migration_name: string;
      finished_at: Date | null;
      rolled_back_at: Date | null;
      applied_steps_count: number;
    }>(
      `SELECT migration_name, finished_at, rolled_back_at, applied_steps_count
         FROM _prisma_migrations ORDER BY started_at`,
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.migration_name).toMatch(/init_tenancy_and_rls$/);
    expect(rows[0]?.finished_at).not.toBeNull();
    expect(rows[0]?.rolled_back_at).toBeNull();
  });

  it('is a no-op when run a second time', async () => {
    const before = await pools.owner.query('SELECT count(*)::int AS n FROM _prisma_migrations');

    const { stdout } = await execFileAsync(PRISMA_BIN, ['migrate', 'deploy'], {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: inject('databaseUrls').appUser,
        DATABASE_MIGRATION_URL: inject('databaseUrls').migrator,
      },
    });

    const after = await pools.owner.query('SELECT count(*)::int AS n FROM _prisma_migrations');

    expect(stdout).toMatch(/No pending migrations/i);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('created every extension the application depends on', async () => {
    const { rows } = await pools.owner.query<{ extname: string }>(
      'SELECT extname FROM pg_extension ORDER BY extname',
    );
    const installed = rows.map((row) => row.extname);

    for (const extension of REQUIRED_EXTENSIONS) {
      expect(installed, extension).toContain(extension);
    }
  });

  /**
   * `deleted_at` is asserted *per the registry*, not for every table.
   *
   * Soft deletion is a property of the entity, not of the schema: a session is revoked and a reset
   * token is spent, and neither is archived (docs/architecture/data-model.md, «Мягкое удаление»).
   * Asserting the column everywhere would have to be dropped the moment such a table lands, and
   * dropping it would also stop catching a softly deleted table that shipped without it — which is
   * the failure that matters, because the global `deletedAt IS NULL` filter then has nothing to
   * read and the row never disappears from a list. `tenant-tables.test.ts` holds the flag against
   * the Prisma schema, so the two halves cannot drift apart.
   */
  it('created every table of the registry with uuid keys and timestamptz columns', async () => {
    const { rows } = await pools.owner.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name IN ('id', 'created_at', 'updated_at', 'deleted_at')`,
    );

    for (const [table, spec] of Object.entries(TENANT_TABLES)) {
      const columns = rows.filter((row) => row.table_name === table);
      const typeOf = (column: string): string | undefined =>
        columns.find((candidate) => candidate.column_name === column)?.data_type;

      expect(typeOf('id'), table).toBe('uuid');
      for (const column of ['created_at', 'updated_at']) {
        expect(typeOf(column), `${table}.${column}`).toBe('timestamp with time zone');
      }

      expect(typeOf('deleted_at'), `${table}.deleted_at`).toBe(
        spec.softDeleted ? 'timestamp with time zone' : undefined,
      );
    }
  });

  /**
   * The labels of the two enums, written out rather than derived.
   *
   * A PostgreSQL enum value cannot be renamed or removed without recreating the type and rewriting
   * every column that uses it, so the names are a decision with a one-way door — which is why they
   * are asserted where a rename shows up as a failing test rather than as a diff nobody read.
   * `OFFBOARDING` in particular replaced `USER_DELETED`: the same value closes the sessions of an
   * account that was merely suspended, where nothing was deleted at all
   * (`docs/architecture/data-model.md`, «Про каскады»), and STORY-012-05 names it.
   */
  it.each([
    ['user_status', ['ACTIVE', 'INVITED', 'SUSPENDED']],
    [
      'session_revoked_reason',
      ['LOGOUT', 'OFFBOARDING', 'PASSWORD_CHANGED', 'REUSE_DETECTED', 'REVOKED_BY_USER', 'ROTATED'],
    ],
  ])('created the enum %s with exactly the labels the model declares', async (name, labels) => {
    const { rows } = await pools.owner.query<{ label: string }>(
      `SELECT e.enumlabel AS label
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = $1
        ORDER BY e.enumlabel`,
      [name],
    );

    expect(rows.map((row) => row.label)).toEqual(labels);
  });

  /**
   * The privacy half of `Session`, as columns: a hash that cannot be read back, and a redacted form
   * that can. Neither is the address (`CLAUDE.md`, «Персональные данные»).
   *
   * `ip_masked` is NOT NULL on purpose and while the table is empty: a nullable column here would be
   * nullable for the life of the product, and the API field it feeds optional with it — every reader
   * then carrying a branch for an address that is simply always absent.
   */
  it('keeps the session address hashed and redacted, both mandatory', async () => {
    const { rows } = await pools.owner.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sessions'
          AND column_name LIKE 'ip%'
        ORDER BY column_name`,
    );

    expect(rows).toEqual([
      { column_name: 'ip_hash', is_nullable: 'NO' },
      { column_name: 'ip_masked', is_nullable: 'NO' },
    ]);
  });
});

/**
 * `updated_at` is maintained by the database, because the only other candidate cannot do it.
 *
 * Prisma's `@updatedAt` is computed in the **client**: it is a value Prisma adds to the statements
 * Prisma builds. Every write that does not go through it — and this model prescribes several, from
 * the family revocation of `docs/architecture/data-model.md` («Про refresh-семейства») to the
 * offboarding update — leaves the column holding whatever it held before, which is a timestamp that
 * lies rather than a timestamp that is missing.
 *
 * The test writes the way those statements write: raw SQL, and with an explicit old value, so a
 * passing run means the database overrode the client rather than that two `now()` calls differed.
 */
describe('updated_at is kept by the database', () => {
  it.each(Object.keys(TENANT_TABLES))('survives a raw write to %s', async (table) => {
    await truncateAll(pools.owner);

    const organizationId = randomUUID();
    const row = await asMaintenance(pools.owner, async (client) => {
      await ROW_FACTORIES.organizations(client, organizationId);

      return table === 'organizations'
        ? { id: organizationId }
        : await ROW_FACTORIES[table as keyof typeof ROW_FACTORIES](client, organizationId);
    });

    const updated = await asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{ updated_at: Date }>(
        `UPDATE ${table} SET updated_at = TIMESTAMPTZ '2000-01-01T00:00:00Z'
          WHERE id = $1 RETURNING updated_at`,
        [row.id],
      );

      return rows[0]?.updated_at;
    });

    expect(
      updated?.getUTCFullYear(),
      `${table}.updated_at was written by the client`,
    ).toBeGreaterThan(2000);
  });
});

describe('row level security in the catalog', () => {
  const policiesOf = (table: string): RlsPolicyFacts[] =>
    catalog.policies.filter((policy) => policy.table === table);

  it('has both ENABLE and FORCE on every tenant table', () => {
    for (const table of Object.keys(TENANT_TABLES)) {
      const entry = catalog.tables.find((row) => row.table === table);

      expect(entry?.rlsEnabled, `${table}: ENABLE ROW LEVEL SECURITY`).toBe(true);
      expect(entry?.rlsForced, `${table}: FORCE ROW LEVEL SECURITY`).toBe(true);
    }
  });

  it.each(Object.entries(TENANT_TABLES))(
    '%s carries a tenant policy for app_user with USING and WITH CHECK, both canonical',
    (table, spec) => {
      // The column the registry declares, not "either of the two": on an ordinary tenant table a
      // predicate over `id` compares a primary key with an organization id and matches nothing.
      const canonical = CANONICAL_TENANT_PREDICATE[spec.tenantColumn];
      const tenantPolicy = policiesOf(table).find((policy) => policy.roles.includes('app_user'));

      expect(tenantPolicy, `${table}: no policy addressed to app_user`).toBeDefined();
      expect(tenantPolicy?.command, `${table}: policy must cover every command`).toBe('*');
      expect(tenantPolicy?.using ?? '', `${table}: USING`).toMatch(canonical);
      // Written out even where PostgreSQL would substitute USING: the substitution disappears the
      // moment the policy is split per command, and the catalog reads NULL either way, so no
      // automated check could tell "relied on the default" from "forgot it".
      expect(tenantPolicy?.check ?? '', `${table}: WITH CHECK`).toMatch(canonical);
    },
  );

  it.each(Object.keys(TENANT_TABLES))(
    '%s addresses its policy to a role, never to PUBLIC',
    (table) => {
      for (const policy of policiesOf(table)) {
        expect(policy.roles, `${table}.${policy.policy}`).not.toEqual([]);
        expect(policy.roles, `${table}.${policy.policy}`).not.toContain('public');
      }
    },
  );

  /**
   * PERMISSIVE policies combine with OR, so a second permissive policy for `app_user` widens access
   * rather than narrowing it. Anything beyond the canonical tenant policy has to be RESTRICTIVE or
   * carry the tenant predicate inside it (docs/security/rls-design.md, «Ловушка»).
   */
  /**
   * Every role, not `app_user` alone. A permissive policy combines with OR within the role it is
   * addressed to, so `TO app_migrator USING (true)` widens nothing for the application and hands
   * every migration, psql session and restore the rows of every organization.
   */
  it.each(Object.entries(TENANT_TABLES))(
    '%s has no permissive policy that widens any role',
    (table, spec) => {
      const canonical = CANONICAL_TENANT_PREDICATE[spec.tenantColumn];
      const widening = policiesOf(table).filter(
        (policy) =>
          policy.permissive &&
          !canonical.test(policy.using ?? '') &&
          !CANONICAL_MAINTENANCE_PREDICATE.test(policy.using ?? ''),
      );

      expect(widening.map((policy) => policy.policy)).toEqual([]);
    },
  );

  it.each(Object.keys(TENANT_TABLES))(
    '%s keeps the owner behind an explicit maintenance switch',
    (table) => {
      const maintenance = policiesOf(table).find((policy) => policy.roles.includes('app_migrator'));

      expect(maintenance?.using ?? '').toMatch(CANONICAL_MAINTENANCE_PREDICATE);
    },
  );

  /**
   * The same catalog, judged by the same module `pnpm check:rls` runs. The per-table assertions
   * above say which table is wrong; this one says whether the migration as a whole would pass the
   * check an operator runs on staging — including the cross-check between the catalog, the Prisma
   * schema and the tenant registry, which no per-table assertion covers.
   */
  it('passes the audit that pnpm check:rls performs', () => {
    expect(rlsCatalogViolations(catalog)).toEqual([]);
  });
});

/**
 * The half of invariant 1 that row-level security cannot enforce and no behavioural test reaches.
 *
 * Foreign key checks run as system triggers under the table owner and **bypass** row-level security
 * — documented PostgreSQL behaviour. A single-column `REFERENCES users (id)` therefore happily
 * confirms a user of another organization: the child row carries the caller's own
 * `organization_id`, so no policy is violated, the referenced row exists, so no key is violated, and
 * the two tenants are now stitched together. Side effect: the success or failure of the insert is an
 * oracle for the existence of a foreign id.
 *
 * `(organization_id, parent_id) REFERENCES parent (organization_id, id)` closes both in one clause,
 * which is why the checklist of `docs/security/rls-design.md` makes it item 2 — and why it is worth
 * a check that reads the catalog rather than the migration text.
 */
describe('foreign keys between tenant tables', () => {
  interface ForeignKeyFacts {
    readonly constraint: string;
    readonly table: string;
    readonly target: string;
    readonly columns: string[];
    readonly targetColumns: string[];
  }

  let foreignKeys: ForeignKeyFacts[];

  beforeAll(async () => {
    const { rows } = await pools.owner.query<{
      constraint_name: string;
      table_name: string;
      target_table: string;
      columns: string[];
      target_columns: string[];
    }>(
      `SELECT con.conname                        AS constraint_name,
              src.relname                        AS table_name,
              tgt.relname                        AS target_table,
              ARRAY(SELECT a.attname::text
                      FROM unnest(con.conkey) AS k
                      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k)  AS columns,
              ARRAY(SELECT a.attname::text
                      FROM unnest(con.confkey) AS k
                      JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k) AS target_columns
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_class tgt ON tgt.oid = con.confrelid
         JOIN pg_namespace n ON n.oid = src.relnamespace
        WHERE con.contype = 'f' AND n.nspname = 'public'
        ORDER BY src.relname, con.conname`,
    );

    foreignKeys = rows.map((row) => ({
      constraint: row.constraint_name,
      table: row.table_name,
      target: row.target_table,
      columns: row.columns,
      targetColumns: row.target_columns,
    }));
  });

  /** Positive control: the query returns keys at all, so the filters below judge something. */
  it('finds the foreign keys of the schema', () => {
    expect(foreignKeys.length).toBeGreaterThan(0);
  });

  it('carries the tenant on every reference from one tenant table to another', () => {
    const registry: Record<string, unknown> = TENANT_TABLES;
    const singleColumn = foreignKeys
      .filter(
        (key) =>
          registry[key.table] !== undefined &&
          registry[key.target] !== undefined &&
          // A reference to the tenant root is the tenant column itself; there is nothing to pair
          // it with, and `organizations` has no `organization_id` to point at.
          key.target !== 'organizations',
      )
      .filter(
        (key) =>
          !key.columns.includes('organization_id') ||
          !key.targetColumns.includes('organization_id'),
      );

    expect(
      singleColumn.map((key) => `${key.table}.${key.constraint} → ${key.target}`),
      'a single-column reference confirms a parent row of another organization: FK checks bypass RLS',
    ).toEqual([]);
  });

  it('anchors every tenant table to the organization it belongs to', () => {
    const anchored = new Set(
      foreignKeys
        .filter((key) => key.target === 'organizations' && key.columns.includes('organization_id'))
        .map((key) => key.table),
    );
    const missing = Object.entries(TENANT_TABLES)
      .filter(([table, spec]) => spec.tenantColumn === 'organization_id' && !anchored.has(table))
      .map(([table]) => table);

    expect(missing).toEqual([]);
  });
});

describe('grants', () => {
  it.each(Object.entries(TENANT_TABLES))(
    '%s gives app_user exactly the privileges the registry declares',
    async (table, spec) => {
      const actual = await appUserPrivileges(pools.owner, table);

      expect(actual).toEqual([...spec.appUserPrivileges].sort());
    },
  );

  it('never grants TRUNCATE to app_user, on any table', async () => {
    const { rows } = await pools.owner.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND has_table_privilege('app_user', c.oid, 'TRUNCATE')`,
    );

    expect(rows.map((row) => row.relname)).toEqual([]);
  });

  it('leaves PUBLIC with nothing at all', async () => {
    const { rows } = await pools.owner.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE')`,
    );

    expect(rows.map((row) => row.relname)).toEqual([]);
  });

  /**
   * Every table, `_prisma_migrations` included. `pg_dump` takes an ACCESS SHARE lock on everything
   * it is about to read before it reads anything, so one table without this grant fails the whole
   * dump — and a backup that fails at 3 a.m. is discovered on the day it is needed.
   */
  it('lets backup_role read every table in the schema', async () => {
    const { rows } = await pools.owner.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND NOT has_table_privilege('backup_role', c.oid, 'SELECT')`,
    );

    expect(rows.map((row) => row.relname)).toEqual([]);
  });

  it('lets backup_role read every sequence, which pg_dump also touches', async () => {
    // MATERIALIZED, because the planner is free to evaluate `has_sequence_privilege` before the
    // `relkind` filter and then fails on the first TOAST relation it meets: `"pg_toast_17590" is
    // not a sequence`. The CTE fences the filter off from the function.
    const { rows } = await pools.owner.query<{ relname: string }>(
      `WITH sequences AS MATERIALIZED (
         SELECT c.oid, c.relname
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'S'
       )
       SELECT relname FROM sequences
        WHERE NOT has_sequence_privilege('backup_role', oid, 'SELECT')`,
    );

    expect(rows.map((row) => row.relname)).toEqual([]);
  });

  it('gives backup_role no way to write', async () => {
    const { rows } = await pools.owner.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND has_table_privilege('backup_role', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')`,
    );

    expect(rows.map((row) => row.relname)).toEqual([]);
  });

  /**
   * The repair direction, and the one that matters.
   *
   * `01-grants.sql` is called the source of truth for privileges precisely because `pg_restore`
   * runs with `--no-privileges`: after a restore no table has a single GRANT, and this file is what
   * puts them back. The test below only proved the file is idempotent — it never revoked anything
   * first, so a table the file silently skips looked identical to a table it handles correctly.
   *
   * `organizations` is exactly that table. It is the tenant root, so it has no `organization_id`
   * column — its policy compares `id` — and a classifier keyed on that column name does not see it
   * as a tenant table at all. The consequence is not a leak but a total outage after every restore:
   * login, organization resolution and sign-up all hit `permission denied for table organizations`.
   */
  it.each(['organizations', 'teams'])(
    'restores app_user privileges on %s after a restore has stripped them',
    async (table) => {
      const privilegesOf = async (): Promise<string[]> =>
        (
          await pools.owner.query<{ privilege_type: string }>(
            `SELECT privilege_type
               FROM information_schema.table_privileges
              WHERE table_schema = 'public' AND table_name = $1 AND grantee = 'app_user'
              ORDER BY privilege_type`,
            [table],
          )
        ).rows.map((row) => row.privilege_type);

      const expected = await privilegesOf();
      expect(expected.length, `${table} starts with no privileges to restore`).toBeGreaterThan(0);

      // What `pg_restore --no-privileges` leaves behind.
      await pools.owner.query(`REVOKE ALL ON TABLE public.${table} FROM app_user`);
      expect(await privilegesOf()).toEqual([]);

      await reapplyGrants(pools.owner);

      expect(await privilegesOf()).toEqual(expected);
    },
  );

  it('changes nothing when 01-grants.sql runs a second time', async () => {
    const snapshot = async (): Promise<unknown[]> =>
      (
        await pools.owner.query(
          `SELECT grantee, table_name, privilege_type
             FROM information_schema.table_privileges
            WHERE table_schema = 'public' AND grantee IN ('app_user', 'backup_role', 'PUBLIC')
            ORDER BY grantee, table_name, privilege_type`,
        )
      ).rows;

    const before = await snapshot();
    await reapplyGrants(pools.owner);
    const after = await snapshot();

    expect(before.length).toBeGreaterThan(0);
    expect(after).toEqual(before);
  });
});

describe('database roles', () => {
  it('runs the application under a role that cannot escape RLS', async () => {
    const { rows } = await pools.owner.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
        WHERE rolname IN ('app_user', 'app_migrator', 'app_auth', 'backup_role')`,
    );
    const roleNamed = (name: string) => rows.find((row) => row.rolname === name);

    expect(roleNamed('app_user')?.rolbypassrls).toBe(false);
    expect(roleNamed('app_user')?.rolsuper).toBe(false);
    expect(roleNamed('app_migrator')?.rolbypassrls).toBe(false);
    // Without BYPASSRLS the dump is silently partial rather than failing (backup-restore runbook).
    expect(roleNamed('backup_role')?.rolbypassrls).toBe(true);
    expect(roleNamed('app_auth')?.rolbypassrls).toBe(true);
  });

  /**
   * MEMBER and not USAGE: with NOINHERIT — which all four roles are — `USAGE` answers false for a
   * role that can still `SET ROLE` into the other one, so the check would pass over the exact
   * misconfiguration it is meant to catch (docs/security/rls-design.md).
   */
  it('lets no role become another', async () => {
    const { rows } = await pools.owner.query<{ member: string; granted: string }>(
      `SELECT m.rolname AS member, g.rolname AS granted
         FROM pg_roles m CROSS JOIN pg_roles g
        WHERE m.rolname <> g.rolname
          AND m.rolname IN ('app_user', 'app_migrator', 'app_auth', 'backup_role')
          AND g.rolname IN ('app_user', 'app_migrator', 'app_auth', 'backup_role')
          AND pg_has_role(m.rolname, g.oid, 'MEMBER')`,
    );

    expect(rows.map((row) => `${row.member} → ${row.granted}`)).toEqual([]);
  });
});

describe('the backup path', () => {
  beforeEach(async () => {
    await truncateAll(pools.owner);
    await asMaintenance(pools.owner, async (client) => {
      await ROW_FACTORIES.organizations(client, randomUUID());
      await ROW_FACTORIES.organizations(client, randomUUID());
    });
  });

  /**
   * The positive control of the whole backup story: `backup_role` must see rows of *every* tenant
   * without setting any context. A dump that sees one tenant, or none, restores as a database that
   * lost the rest — and looks like a successful backup until then.
   */
  it('reads every tenant’s rows without a tenant context', async () => {
    const { rows } = await pools.backup.query<{ count: string }>(
      'SELECT count(*) FROM organizations',
    );

    expect(Number(rows[0]?.count)).toBe(2);
  });

  it('cannot write, even though it can read everything', async () => {
    await expect(
      pools.backup.query(
        `INSERT INTO organizations (id, slug, name, updated_at) VALUES ($1, 'x', 'x', now())`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
