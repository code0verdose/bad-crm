import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  readRlsCatalog,
  rlsCatalogViolations,
} from '@/infrastructure/persistence/prisma/rls-catalog.util.js';

import { closePools, createPools, type HarnessPools } from './db-harness.util.js';

/**
 * `pnpm check:rls` against a real database, including the half that matters: the broken one.
 *
 * A check that has only ever been run against a correct database is an `echo OK`. Each spec below
 * breaks exactly one thing in the catalog — the `WITH CHECK` of a policy, the `FORCE` of a table,
 * the role a policy is addressed to — asserts that the script exits non-zero and names it, and puts
 * the catalog back. All three are invisible to every behavioural test in this directory: the
 * application connects as `app_user`, and for `app_user` a database missing `FORCE` behaves exactly
 * like one that has it.
 *
 * The script is executed as a process rather than imported, because its exit code is the whole of
 * its contract with CI and with an operator's `&&`.
 */

const SCRIPT = fileURLToPath(new URL('../../../scripts/check-rls.ts', import.meta.url));
const TSX_BIN = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));

/** The canonical policy of the migration, restored after every spec that breaks it. */
const CANONICAL_TEAMS_POLICY = `CREATE POLICY "tenant_isolation" ON "teams"
   AS PERMISSIVE FOR ALL TO app_user
   USING      ("organization_id" = current_setting('app.organization_id')::uuid)
   WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid)`;

/** The other half of the migration's template: the owner behind an explicit switch. */
const CANONICAL_MAINTENANCE_POLICY = `CREATE POLICY "maintenance_access" ON "teams"
   AS PERMISSIVE FOR ALL TO app_migrator
   USING      (current_setting('app.maintenance', true) = 'on')
   WITH CHECK (current_setting('app.maintenance', true) = 'on')`;

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCheck = async (args: string[], env: Record<string, string> = {}): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(
      TSX_BIN,
      [SCRIPT, ...args],
      // A clean `DATABASE_URL` unless a spec sets one: the developer's own environment must not
      // decide which database this suite reports on.
      { env: { ...process.env, DATABASE_URL: '', ...env } },
      (error, stdout, stderr) => {
        resolve({
          code: error === null ? 0 : Number((error as NodeJS.ErrnoException).code ?? 1),
          stdout,
          stderr,
        });
      },
    );
  });

let pools: HarnessPools;

beforeAll(() => {
  pools = createPools();
});

afterAll(async () => {
  await closePools(pools);
});

afterEach(async () => {
  // Whatever a spec broke, the next file in the run gets the database the migration produced.
  await pools.owner.query('DROP POLICY IF EXISTS "tenant_isolation" ON "teams"');
  await pools.owner.query('DROP POLICY IF EXISTS "everyone" ON "teams"');
  await pools.owner.query('DROP POLICY IF EXISTS "maintenance_access" ON "teams"');
  await pools.owner.query(CANONICAL_MAINTENANCE_POLICY);
  await pools.owner.query(CANONICAL_TEAMS_POLICY);
  await pools.owner.query('ALTER TABLE "teams" FORCE ROW LEVEL SECURITY');
  await pools.owner.query('ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY');
  await pools.owner.query('DROP TABLE IF EXISTS "public"."rogue_notes"');
});

describe('the audit reads the database this repository migrates', () => {
  it('finds nothing wrong with it', async () => {
    const facts = await readRlsCatalog(async (sql) => (await pools.owner.query(sql)).rows);

    expect(rlsCatalogViolations(facts)).toEqual([]);
  });
});

describe('pnpm check:rls on a healthy database', () => {
  it('exits 0 and reports what it compared', async () => {
    const result = await runCheck([inject('databaseUrls').migrator]);

    expect(result.stdout).toContain('OK');
    expect(result.stdout).toContain('FORCE ROW LEVEL SECURITY');
    expect(result.code).toBe(0);
  });

  /**
   * Every query the check makes is a `SELECT` over `pg_catalog`, which is world-readable — so the
   * tool needs no privileged role, and an operator can point it at a host with the credentials the
   * application already uses. Asserted rather than claimed: `pg_get_expr` on a foreign relation is
   * exactly the kind of call that turns out to need ownership.
   */
  it('needs no more than app_user, the least privileged role there is', async () => {
    const result = await runCheck([inject('databaseUrls').appUser]);

    expect(result.stdout).toContain('OK');
    expect(result.stdout).toContain('app_user');
    expect(result.code).toBe(0);
  });

  /**
   * `pnpm check:rls -- <url>` — the invocation every rule and runbook writes down — forwards the
   * `--` to the script as well, so the connection string arrives as the *second* argument. Reading
   * `argv[2]` blindly made the documented command print the usage and exit 2.
   */
  it('accepts the -- separator that pnpm passes through', async () => {
    const result = await runCheck(['--', inject('databaseUrls').migrator]);

    expect(result.stdout).toContain('OK');
    expect(result.code).toBe(0);
  });

  it('takes the connection string from DATABASE_URL when given no argument', async () => {
    const result = await runCheck([], { DATABASE_URL: inject('databaseUrls').migrator });

    expect(result.stdout).toContain('OK');
    expect(result.code).toBe(0);
  });

  it('never prints the password it connected with', async () => {
    const result = await runCheck([inject('databaseUrls').migrator]);

    expect(`${result.stdout}${result.stderr}`).not.toContain('test_migrator');
  });
});

describe('pnpm check:rls on a database somebody broke', () => {
  /**
   * The finding this whole tool exists for. PostgreSQL applies `USING` when a `FOR ALL` policy has
   * no `WITH CHECK`, so this database still passes every isolation test in this directory — and the
   * substitution ends the day the policy is split per command, at which point a tenant writes rows
   * into another tenant.
   */
  it('CONTROL: catches a tenant policy that lost its WITH CHECK', async () => {
    await pools.owner.query('DROP POLICY "tenant_isolation" ON "teams"');
    await pools.owner.query(`CREATE POLICY "tenant_isolation" ON "teams"
       AS PERMISSIVE FOR ALL TO app_user
       USING ("organization_id" = current_setting('app.organization_id')::uuid)`);

    const result = await runCheck([inject('databaseUrls').migrator]);

    expect(result.stdout).toContain('teams.tenant_isolation');
    expect(result.stdout).toContain('WITH CHECK');
    expect(result.stdout).not.toContain('OK');
    expect(result.code).toBe(1);
  });

  it('CONTROL: catches a tenant table that lost FORCE ROW LEVEL SECURITY', async () => {
    await pools.owner.query('ALTER TABLE "teams" NO FORCE ROW LEVEL SECURITY');

    const result = await runCheck([inject('databaseUrls').migrator]);

    expect(result.stdout).toMatch(/teams[\s\S]*not forced/);
    expect(result.code).toBe(1);
  });

  it('CONTROL: catches a tenant table with row level security switched off', async () => {
    await pools.owner.query('ALTER TABLE "teams" DISABLE ROW LEVEL SECURITY');

    const result = await runCheck([inject('databaseUrls').migrator]);

    expect(result.stdout).toMatch(/teams[\s\S]*not enabled/);
    expect(result.code).toBe(1);
  });

  it('CONTROL: catches a policy addressed to PUBLIC instead of app_user', async () => {
    await pools.owner.query(`CREATE POLICY "everyone" ON "teams"
       AS PERMISSIVE FOR ALL TO PUBLIC USING (true)`);

    const result = await runCheck([inject('databaseUrls').migrator]);

    // The subject, not the word «PUBLIC»: the report names PUBLIC in its list of checks too, and an
    // assertion that matches the header passes just as well on a run that found nothing.
    expect(result.stdout).toContain('teams.everyone');
    expect(result.code).toBe(1);
  });

  /**
   * The probe that came back clean before this was fixed: **zero findings**.
   *
   * The canonicity check ran over the policies addressed to `app_user` and over nothing else, so a
   * permissive policy for any other role was invisible to it. The realistic way to get one is a
   * hand repair on staging — `maintenance_access` dropped and recreated without its switch
   * predicate — after which every `app_migrator` connection (migrations, psql, a maintenance
   * script, the restore itself) reads every organization again, and `pnpm check:rls` printed OK.
   * In CI `migrations.test.ts` catches it; on the live host this script is written for, nothing did.
   */
  it('CONTROL: catches a permissive policy for the owner that lost its switch predicate', async () => {
    await pools.owner.query('DROP POLICY "maintenance_access" ON "teams"');
    await pools.owner.query(`CREATE POLICY "maintenance_access" ON "teams"
       AS PERMISSIVE FOR ALL TO app_migrator USING (true) WITH CHECK (true)`);

    const result = await runCheck([inject('databaseUrls').migrator]);

    // The problem text, not the word «PERMISSIVE»: the report names it in the list of checks it
    // performed too, and an assertion matching the header passes on a run that found nothing.
    expect(result.stdout).toContain('teams.maintenance_access');
    expect(result.stdout).toContain('widens the access of app_migrator');
    expect(result.stdout).not.toContain('OK');
    expect(result.code).toBe(1);
  });

  /**
   * The second probe that came back clean: the template accepted `id` and `organization_id` for
   * every table, though the registry declares one per table. On `teams` the predicate compares a
   * primary key with an organization id, so it matches nothing — fail-closed, and therefore
   * reported by no isolation test either: every negative assertion in `rls-isolation.test.ts` is
   * also true when nothing is visible. It presents as "there is no data".
   */
  it('CONTROL: catches a tenant policy comparing the wrong column', async () => {
    await pools.owner.query('DROP POLICY "tenant_isolation" ON "teams"');
    await pools.owner.query(`CREATE POLICY "tenant_isolation" ON "teams"
       AS PERMISSIVE FOR ALL TO app_user
       USING      ("id" = current_setting('app.organization_id')::uuid)
       WITH CHECK ("id" = current_setting('app.organization_id')::uuid)`);

    const result = await runCheck([inject('databaseUrls').migrator]);

    expect(result.stdout).toContain('teams.tenant_isolation');
    expect(result.stdout).toContain('canonical');
    expect(result.code).toBe(1);
  });

  /**
   * The direction a container-started suite cannot see at all: a table that exists on the host and
   * in no migration of this checkout. On staging that is how a hand-made repair survives a restore.
   */
  it('CONTROL: catches a table carrying organization_id that no registry lists', async () => {
    await pools.owner.query(
      'CREATE TABLE "public"."rogue_notes" (id uuid PRIMARY KEY, organization_id uuid NOT NULL)',
    );

    const result = await runCheck([inject('databaseUrls').migrator]);

    expect(result.stdout).toContain('rogue_notes');
    expect(result.code).toBe(1);
  });
});

describe('pnpm check:rls when it cannot run at all', () => {
  it('separates "could not run" from "the database is wrong"', async () => {
    const result = await runCheck(['postgresql://nobody@127.0.0.1:1/nothing']);

    expect(result.stderr).toContain('could not run');
    expect(result.stderr).not.toContain('at Object.'); // a stack trace, not a diagnosis
    expect(result.code).toBe(2);
  });

  it('prints the usage when it is given no connection string', async () => {
    const result = await runCheck([]);

    expect(result.stderr).toContain('DATABASE_URL');
    expect(result.code).toBe(2);
  });
});
