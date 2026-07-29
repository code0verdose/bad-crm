import { describe, expect, it } from 'vitest';

import { rolesRequiredBy } from './migration-roles.util.js';

/**
 * The extractor behind `upgrade-runbook.test.ts`, on its own.
 *
 * That suite makes a general claim — «every role named by any committed migration is a role the
 * bootstrap creates» — and the claim is only as wide as this function. A shape it does not see is a
 * role nobody checks, and the symptom appears at an operator mid-upgrade as
 * `P3018 … role "x" does not exist`, followed by `P3009` on every later deploy.
 *
 * So the shapes are asserted here rather than assumed. Each case below is a statement PostgreSQL
 * resolves through `get_role_oid` and answers `42704` for when the role is missing; the last block
 * is the other half — text that looks like a role reference and is not.
 */

const roles = (sql: string): string[] => [...rolesRequiredBy(sql)].sort();

describe('the role references an extractor has to see', () => {
  it.each([
    ['GRANT to one role', 'GRANT SELECT ON TABLE users TO app_user;', ['app_user']],
    [
      'GRANT to several roles',
      'GRANT SELECT ON TABLE users TO app_user, backup_role;',
      ['app_user', 'backup_role'],
    ],
    [
      'GRANT with the grant option',
      'GRANT SELECT ON TABLE users TO app_user WITH GRANT OPTION;',
      ['app_user'],
    ],
    [
      'GRANT of role membership — both sides are roles',
      'GRANT app_auth_definer TO app_migrator;',
      ['app_auth_definer', 'app_migrator'],
    ],
    [
      'GRANT of role membership with the admin option',
      'GRANT app_auth_definer TO app_migrator WITH ADMIN OPTION;',
      ['app_auth_definer', 'app_migrator'],
    ],
    [
      'REVOKE from a role',
      'REVOKE ALL ON TABLE users FROM app_auth_definer;',
      ['app_auth_definer'],
    ],
    ['REVOKE with CASCADE', 'REVOKE SELECT ON TABLE users FROM app_user CASCADE;', ['app_user']],
    [
      'ALTER … OWNER TO',
      'ALTER FUNCTION auth_lookup_session(bytea) OWNER TO app_auth_definer;',
      ['app_auth_definer'],
    ],
    ['ALTER TABLE … OWNER TO', 'ALTER TABLE users OWNER TO app_migrator;', ['app_migrator']],
    ['SET ROLE', 'SET ROLE app_auth_definer;', ['app_auth_definer']],
    ['SET LOCAL ROLE', 'SET LOCAL ROLE app_auth_definer;', ['app_auth_definer']],
    [
      'a quoted role name',
      'ALTER FUNCTION auth_lookup_session(bytea) OWNER TO "app_auth_definer";',
      ['app_auth_definer'],
    ],
    ['a quoted grantee', 'GRANT SELECT ON TABLE users TO "app user";', ['app user']],
    [
      'ALTER DEFAULT PRIVILEGES FOR ROLE',
      'ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public GRANT SELECT ON TABLES TO backup_role;',
      ['app_migrator', 'backup_role'],
    ],
  ])('sees %s', (_name, sql, expected) => {
    expect(roles(sql)).toEqual(expected);
  });

  /**
   * The canonical tenant policy of this project, which every migration that adds a tenant table
   * carries (`docs/security/rls-design.md`). `TO app_user` here is followed by `USING`, not by a
   * semicolon — which is why an extractor anchored on `;` saw none of them.
   */
  it('sees the role of a tenant policy, the shape every tenant migration has', () => {
    const sql = [
      'CREATE POLICY tenant_isolation ON sessions',
      '  FOR ALL',
      '  TO app_user',
      "  USING (organization_id = current_setting('app.organization_id')::uuid)",
      "  WITH CHECK (organization_id = current_setting('app.organization_id')::uuid);",
    ].join('\n');

    expect(roles(sql)).toEqual(['app_user']);
  });

  it('sees the roles of a policy that names several', () => {
    const sql =
      'CREATE POLICY maintenance_access ON users AS PERMISSIVE FOR SELECT TO app_migrator, backup_role USING (true);';

    expect(roles(sql)).toEqual(['app_migrator', 'backup_role']);
  });

  it('sees a role named by ALTER POLICY', () => {
    expect(roles('ALTER POLICY tenant_isolation ON sessions TO app_user;')).toEqual(['app_user']);
  });

  it('reads several statements out of one file', () => {
    const sql = [
      "SET LOCAL lock_timeout = '3s';",
      'CREATE TABLE sessions (id uuid PRIMARY KEY);',
      'ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;',
      'CREATE POLICY tenant_isolation ON sessions FOR ALL TO app_user USING (true);',
      'GRANT SELECT ON TABLE sessions TO backup_role;',
      'REVOKE ALL ON TABLE sessions FROM app_auth_definer;',
    ].join('\n');

    expect(roles(sql)).toEqual(['app_auth_definer', 'app_user', 'backup_role']);
  });
});

describe('what is not a role reference', () => {
  it.each([
    ['PUBLIC', 'REVOKE ALL ON FUNCTION auth_lookup_session(bytea) FROM PUBLIC;'],
    ['a grant to PUBLIC', 'GRANT EXECUTE ON FUNCTION auth_lookup_session(bytea) TO PUBLIC;'],
    ['CURRENT_USER', 'ALTER TABLE users OWNER TO CURRENT_USER;'],
    ['SESSION_USER', 'ALTER TABLE users OWNER TO SESSION_USER;'],
    ['SET ROLE NONE', 'SET ROLE NONE;'],
    ['a search_path assignment', 'SET search_path TO pg_catalog, public;'],
    ['a search_path assignment with LOCAL', 'SET LOCAL search_path TO pg_catalog;'],
    [
      'a function body that mentions no role at all',
      'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
    ],
  ])('ignores %s', (_name, sql) => {
    expect(roles(sql)).toEqual([]);
  });

  it('ignores a role reference that sits in a comment', () => {
    expect(roles('-- GRANT SELECT ON TABLE users TO ghost_role;\nSELECT 1;')).toEqual([]);
  });

  /**
   * A literal is data, not an identifier: `01-grants.sql` builds statements out of strings, and a
   * migration that stored a role name in a column must not make the linter demand that role.
   */
  it('ignores a role name inside a string literal', () => {
    expect(roles("INSERT INTO audit_logs (actor) VALUES ('TO ghost_role');")).toEqual([]);
  });

  /**
   * A dollar-quoted body is a literal too, and it is the one that can contain a semicolon — which
   * is what makes naive statement splitting produce fragments that match nothing or match wrongly.
   */
  it('ignores statements inside a dollar-quoted body and still reads the statement after it', () => {
    const sql = [
      'DO $body$ BEGIN',
      "  RAISE NOTICE 'GRANT SELECT ON TABLE users TO ghost_role';",
      'END $body$;',
      'GRANT SELECT ON TABLE users TO backup_role;',
    ].join('\n');

    expect(roles(sql)).toEqual(['backup_role']);
  });

  /**
   * The same property, with the bait **outside** single quotes — and this is the case that actually
   * exercises dollar-quoting.
   *
   * The test above passes with the dollar-quote branch deleted: its bait sits inside a string
   * literal, so the single-quote branch swallows it either way. Measured — removing the branch left
   * all 33 cases green. Here the `GRANT` is ordinary SQL inside the body, so only dollar-quoting can
   * keep it out of the result, and the extra role appears the moment the branch goes.
   */
  it('ignores an unquoted GRANT inside a dollar-quoted body', () => {
    const sql = [
      'DO $body$ BEGIN',
      '  PERFORM 1;',
      '  GRANT SELECT ON TABLE users TO ghost_role;',
      'END $body$;',
      'GRANT SELECT ON TABLE users TO backup_role;',
    ].join('\n');

    expect(roles(sql)).toEqual(['backup_role']);
  });
});
