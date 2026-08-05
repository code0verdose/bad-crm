import { describe, expect, it } from 'vitest';

import { readGrantsSql } from './compose-fixture.util.js';

/**
 * `01-grants.sql` is the single place that decides which role may touch which object. It exists
 * because `--no-privileges` on both sides of the backup cycle destroys every GRANT: after a restore
 * the database holds all its data and nobody may read it. The assertions below are about the
 * properties that make it safe to run at that moment — everything else is checked live against a
 * container, not by reading text.
 */
describe('01-grants.sql — the single source of truth for grants', () => {
  const sql = readGrantsSql();

  /** The file with `--` comment lines dropped: what psql actually executes. */
  const executable = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  it('walks the catalog instead of listing tables by hand', () => {
    // A hand-written list is wrong the first time somebody adds a table without reading this file,
    // and the symptom is a table missing from the backup — silent until a restore.
    expect(executable).toMatch(/FROM\s+pg_class/);
    expect(executable).toMatch(/pg_namespace/);
    expect(executable).toMatch(/relkind\s+IN\s*\(\s*'r'\s*,\s*'p'\s*\)/);
  });

  it('grants SELECT to backup_role on partition leaves as well as on parents', () => {
    // pg_dump dumps a partitioned table leaf by leaf and checks the privilege on the leaf: a GRANT
    // on the parent does not propagate, and one ungranted leaf fails the whole dump.
    expect(executable).toMatch(/GRANT SELECT ON TABLE[^;']*TO backup_role/);
    expect(executable).toMatch(/relispartition/);
    expect(
      executable,
      'backup_role must not be excluded from partitions the way app_user is',
    ).not.toMatch(/NOT\s+c\.relispartition[\s\S]{0,200}TO backup_role/);
  });

  it('keeps partition leaves unreachable for app_user', () => {
    // Policies are not inherited either: a leaf app_user can address is a leaf with no tenant
    // isolation. REVOKE and not "simply do not grant" — this file is also the repair path.
    expect(executable).toMatch(/REVOKE ALL ON TABLE[^;']*FROM app_user/);
  });

  /**
   * The readiness probe runs as `app_user` and reads `_prisma_migrations`; without the grant a
   * fully migrated installation answers `/ready` with `migrations: down` for ever and never enters
   * the load balancer's rotation. Read-only, because an application that could write this table
   * could mark a failed migration as finished — hiding the state from the probe that exists to
   * notice it.
   *
   * Covered end to end by `packages/server/test/integration/db/readiness-probes.test.ts`; this is
   * the cheap half that fails in the fast loop when the branch is edited away.
   */
  it('lets app_user read the migrations table, and only read it', () => {
    expect(executable).toMatch(/_prisma_migrations/);
    expect(executable).toMatch(/GRANT SELECT ON TABLE[^;']*TO app_user/);
    expect(executable).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE[^;']*FROM app_user/,
    );
  });

  /**
   * The catalogue of permission keys is defined by the code and seeded from it, so the application
   * reads it and never writes it: an application that could write this table could grant itself a
   * permission. It shares the read-only branch with `_prisma_migrations` — same privilege shape,
   * same reason.
   */
  it('lists the permission catalogue among the read-only reference tables', () => {
    expect(executable).toMatch(/global_read\s+CONSTANT text\[\]\s*:=\s*ARRAY\[[^\]]*'permissions'/);
  });

  /**
   * And the branch that serves them grants no writes. `global_read` used to fall into the tenant
   * branch, which grants INSERT, UPDATE and DELETE — the name said «read» and the code said
   * otherwise. No table used it yet, so nothing was broken; the first one would have been.
   */
  it('serves the read-only list from a branch that grants no writes', () => {
    expect(executable).not.toMatch(/rel\.is_tenant_table OR rel\.relname = ANY \(global_read\)/);
    expect(executable).toMatch(/ELSIF rel\.relname = ANY \(global_read\) THEN/);
  });

  it('never grants TRUNCATE to app_user', () => {
    // TRUNCATE ignores row-level security: one statement empties the table for every organization.
    expect(executable).not.toMatch(/GRANT[^;']*TRUNCATE[^;']*TO app_user/);
    expect(executable).toMatch(/REVOKE[^;']*TRUNCATE[^;']*FROM app_user/);
  });

  it('grants the sequences both roles need', () => {
    // pg_dump reads `last_value` out of every sequence and stops on the first one it may not read;
    // app_user needs USAGE for nextval() on any identity/serial column.
    expect(executable).toMatch(/GRANT SELECT ON SEQUENCE[^;']*TO backup_role/);
    expect(executable).toMatch(/GRANT USAGE, SELECT ON SEQUENCE[^;']*TO app_user/);
    expect(executable).toMatch(/relkind\s*=\s*'S'/);
  });

  /**
   * A sequence is reachable only through the table that owns it.
   *
   * The unconditional form of the loop above — `GRANT USAGE, SELECT` on every sequence in the
   * schema — handed app_user the sequences of tables the branches above had just decided it must
   * not see. `USAGE` there lets `nextval()` move a foreign sequence and `SELECT` reads its
   * `last_value`, which estimates the size of a table app_user cannot open. Nothing breaks, which
   * is why only a test keeps it from coming back. `test/integration/db/sequence-grants.test.ts`
   * asserts the same rule against a live catalog, in both directions.
   */
  it('narrows app_user’s sequence grant to sequences whose owning table it may read', () => {
    expect(executable).toMatch(/pg_depend/);
    expect(executable).toMatch(
      /has_table_privilege\('app_user',\s*rel\.owning_table,\s*'SELECT'\)/,
    );
    expect(executable).toMatch(/REVOKE ALL ON SEQUENCE[^;']*FROM app_user/);
  });

  it('keeps backup_role on every sequence, which is what pg_dump needs', () => {
    // The narrowing above must not reach backup_role: one unreadable sequence fails the whole dump.
    expect(executable).not.toMatch(/has_table_privilege[\s\S]{0,200}TO backup_role/);
  });

  it('fails with the real reason when the bootstrap has not been run', () => {
    // Without this, a missing role turns every GRANT into an error that names an object instead of
    // the cause, and the operator debugs the wrong thing.
    expect(executable).toMatch(/pg_roles/);
    expect(executable).toMatch(/RAISE EXCEPTION/);
  });

  /**
   * The classifier for functions is not `prosecdef` alone.
   *
   * `prosecdef` is true of every SECURITY DEFINER function in the schema, this project's and an
   * extension's alike, and the file acts on what it selects: it takes ownership, grants `EXECUTE`
   * to `app_auth` and — to do either — issues `SET LOCAL ROLE <current owner>`. Against an object
   * owned by the cluster superuser that last statement is `permission denied to set role`, and the
   * file is one transaction, so the repair path for a restored database destroys the privileges it
   * exists to restore. Against a function app_migrator happens to own it succeeds, which is worse:
   * an unrelated function silently joins the surface of `DATABASE_AUTH_URL`.
   * `packages/server/test/integration/db/auth-lookup-path.test.ts` proves both against a container.
   */
  it('repairs only the functions the migrations marked as this project’s', () => {
    expect(executable).toMatch(/obj_description|shobj_description|pg_description/);
    expect(executable).toMatch(/bad-crm:auth-resolver/);
  });

  it('excludes objects that belong to an extension', () => {
    // An extension's function is owned by whoever installed it — usually the cluster superuser —
    // and is not this project's to re-own.
    expect(executable).toMatch(/pg_depend/);
    expect(executable).toMatch(/deptype\s*=\s*'e'/);
  });

  it('still stops on a SECURITY DEFINER function of its own schema without a pinned search_path', () => {
    // The narrowing above must not reach the guard: a foreign function that can be made to read a
    // caller-controlled table with the owner's rights is a defect whoever wrote it.
    expect(executable).toMatch(/RAISE\s+EXCEPTION\s*\n?\s*'SECURITY DEFINER function/);
    expect(executable).toMatch(/search\\_path=/);
  });

  /**
   * Fail-closed on the loss of the marker, which is the property the narrowing above made the whole
   * file depend on — and which `pg_dump --no-comments` erases in one flag.
   *
   * Without this the run reports `0 security definer functions` and exits 0 while every resolver is
   * left owned by the restoring role and `EXECUTE`-able by `PUBLIC`.
   * `packages/server/test/integration/db/auth-lookup-path.test.ts` reproduces that end to end; here
   * only the shape is asserted, because a refusal that is deleted from the file passes every
   * behavioural test that does not think to look for it.
   */
  it('refuses an unmarked SECURITY DEFINER function instead of skipping it', () => {
    expect(executable).toMatch(/IF\s+NOT\s+rel\.marked\s+THEN[\s\S]{0,200}RAISE\s+EXCEPTION/);
    expect(executable, 'the refusal does not say how to get the marker back').toMatch(
      /--no-comments/,
    );
  });

  /**
   * And the one case that must *not* be a refusal. An extension's function cannot be repaired by an
   * operator — `ALTER FUNCTION` is undone by the next extension update — and this file is the only
   * way privileges come back after a restore, so refusing would make a restored database
   * unrepairable for as long as the extension is installed.
   */
  it('warns rather than refuses when the function belongs to an extension', () => {
    expect(executable).toMatch(
      /rel\.extension\s+IS\s+NOT\s+NULL\s+THEN[\s\S]{0,400}RAISE\s+WARNING/,
    );
    expect(
      executable,
      'an extension branch that raises an exception makes db:grants unrunnable',
    ).not.toMatch(/rel\.extension\s+IS\s+NOT\s+NULL\s+THEN[\s\S]{0,400}RAISE\s+EXCEPTION/);
  });

  /**
   * `RAISE EXCEPTION` uses `%`, not `%s`. With `%s` the message printed the signature followed by a
   * stray `s` — `… function no_path()s has no fixed search_path` — and this message is the one an
   * operator reads when a deployment stops.
   */
  it('formats the refusal with % and not %s', () => {
    expect(executable).not.toMatch(/RAISE\s+EXCEPTION[\s\S]{0,300}%s/);
  });

  it('applies as one transaction so a failure leaves the previous state', () => {
    expect(executable).toMatch(/^\s*BEGIN;/m);
    expect(executable).toMatch(/^\s*COMMIT;/m);
    expect(executable).toMatch(/\\set ON_ERROR_STOP on/);
  });

  it('is runnable by the schema owner, not only by a superuser', () => {
    // GRANT needs ownership, not superuser rights: a self-host install on managed PostgreSQL has
    // no superuser to spare, and app_migrator owns every object by construction.
    expect(sql).toMatch(/-U app_migrator/);
  });
});
