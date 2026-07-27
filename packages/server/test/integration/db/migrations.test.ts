import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

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

/** The two predicate forms `docs/security/rls-design.md` accepts, and nothing else. */
const CANONICAL_PREDICATE =
  /^\(?(organization_id|id) = \(?(current_setting\('app\.organization_id'(::text)?\)\)?::uuid|app_current_org\(\))\)?$/;

interface PolicyRow {
  readonly table_name: string;
  readonly policy_name: string;
  readonly permissive: string;
  readonly roles: string[];
  readonly command: string;
  readonly using_expression: string | null;
  readonly check_expression: string | null;
}

let pools: HarnessPools;

beforeAll(() => {
  pools = createPools();
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

    for (const table of Object.keys(TENANT_TABLES)) {
      const columns = rows.filter((row) => row.table_name === table);

      expect(columns.find((column) => column.column_name === 'id')?.data_type, table).toBe('uuid');
      for (const column of ['created_at', 'updated_at', 'deleted_at']) {
        expect(
          columns.find((candidate) => candidate.column_name === column)?.data_type,
          `${table}.${column}`,
        ).toBe('timestamp with time zone');
      }
    }
  });
});

describe('row level security in the catalog', () => {
  it('has both ENABLE and FORCE on every tenant table', async () => {
    const { rows } = await pools.owner.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
    );

    for (const table of Object.keys(TENANT_TABLES)) {
      const entry = rows.find((row) => row.relname === table);

      expect(entry?.relrowsecurity, `${table}: ENABLE ROW LEVEL SECURITY`).toBe(true);
      expect(entry?.relforcerowsecurity, `${table}: FORCE ROW LEVEL SECURITY`).toBe(true);
    }
  });

  const policiesOf = async (table: string): Promise<PolicyRow[]> => {
    const { rows } = await pools.owner.query<PolicyRow>(
      `SELECT c.relname                          AS table_name,
              p.polname                          AS policy_name,
              CASE WHEN p.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS permissive,
              ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY (p.polroles)) AS roles,
              p.polcmd::text                     AS command,
              pg_get_expr(p.polqual, p.polrelid)      AS using_expression,
              pg_get_expr(p.polwithcheck, p.polrelid) AS check_expression
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname = $1`,
      [table],
    );

    return rows;
  };

  it.each(Object.keys(TENANT_TABLES))(
    '%s carries a tenant policy for app_user with USING and WITH CHECK, both canonical',
    async (table) => {
      const tenantPolicy = (await policiesOf(table)).find((policy) =>
        policy.roles.includes('app_user'),
      );

      expect(tenantPolicy, `${table}: no policy addressed to app_user`).toBeDefined();
      expect(tenantPolicy?.command, `${table}: policy must cover every command`).toBe('*');
      expect(tenantPolicy?.using_expression ?? '', `${table}: USING`).toMatch(CANONICAL_PREDICATE);
      // Written out even where PostgreSQL would substitute USING: the substitution disappears the
      // moment the policy is split per command, and `polwithcheck` reads as NULL in the catalog,
      // so no automated check could tell "relied on the default" from "forgot it".
      expect(tenantPolicy?.check_expression ?? '', `${table}: WITH CHECK`).toMatch(
        CANONICAL_PREDICATE,
      );
    },
  );

  it.each(Object.keys(TENANT_TABLES))(
    '%s addresses its policy to a role, never to PUBLIC',
    async (table) => {
      for (const policy of await policiesOf(table)) {
        expect(policy.roles, `${table}.${policy.policy_name}`).not.toEqual([]);
        expect(policy.roles, `${table}.${policy.policy_name}`).not.toContain('public');
      }
    },
  );

  /**
   * PERMISSIVE policies combine with OR, so a second permissive policy for `app_user` widens access
   * rather than narrowing it. Anything beyond the canonical tenant policy has to be RESTRICTIVE or
   * carry the tenant predicate inside it (docs/security/rls-design.md, «Ловушка»).
   */
  it.each(Object.keys(TENANT_TABLES))(
    '%s has no permissive policy that widens app_user',
    async (table) => {
      const widening = (await policiesOf(table)).filter(
        (policy) =>
          policy.permissive === 'PERMISSIVE' &&
          policy.roles.includes('app_user') &&
          !CANONICAL_PREDICATE.test(policy.using_expression ?? ''),
      );

      expect(widening.map((policy) => policy.policy_name)).toEqual([]);
    },
  );

  it.each(Object.keys(TENANT_TABLES))(
    '%s keeps the owner behind an explicit maintenance switch',
    async (table) => {
      const maintenance = (await policiesOf(table)).find((policy) =>
        policy.roles.includes('app_migrator'),
      );

      // The catalog prints the expression with its casts (`'app.maintenance'::text`), so the shape is
      // matched rather than the source text.
      expect(maintenance?.using_expression ?? '').toMatch(
        /current_setting\('app\.maintenance'(::text)?, true\) = 'on'(::text)?/,
      );
    },
  );
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
