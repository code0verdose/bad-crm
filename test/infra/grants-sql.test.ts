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
