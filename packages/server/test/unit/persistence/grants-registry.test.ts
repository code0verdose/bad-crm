import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TENANT_TABLES } from '@/infrastructure/persistence/prisma/tenant-tables.constant.js';

/**
 * `01-grants.sql` and `tenant-tables.constant.ts` describe the same thing — which privileges the
 * application role holds on which table — in two languages that cannot import each other. SQL runs
 * against a live catalogue; the registry is what TypeScript and the tests read.
 *
 * That duplication already produced one outage-class defect. The SQL classified a tenant table by
 * the presence of an `organization_id` column, which the tenant root does not have: `organizations`
 * fell through every branch, `app_user` was granted nothing on it, and since `pg_restore` runs with
 * `--no-privileges`, every restore ended with the application unable to read the table that
 * resolves the tenant. The registry said one thing, the SQL did another, and nothing compared them.
 *
 * So they are compared here. The duplication stays — SQL genuinely cannot read a TypeScript module
 * — but a divergence stops being something a person has to notice.
 */

const GRANTS_SQL = readFileSync(
  fileURLToPath(new URL('../../../prisma/sql/01-grants.sql', import.meta.url)),
  'utf8',
);

/** The table names of a `name CONSTANT text[] := ARRAY[...]` declaration. */
const sqlList = (name: string): string[] => {
  const declaration = new RegExp(`${name}\\s+CONSTANT text\\[\\]\\s*:=\\s*ARRAY\\[([^\\]]*)\\]`);
  const match = declaration.exec(GRANTS_SQL);

  expect(match, `01-grants.sql no longer declares a list named ${name}`).not.toBeNull();

  const body = (match as RegExpExecArray)[1] as string;

  return [...body.matchAll(/'([^']+)'/g)].map((entry) => entry[1] as string);
};

const registryTablesWithout = (privilege: string): string[] =>
  Object.entries(TENANT_TABLES)
    .filter(([, spec]) => !(spec.appUserPrivileges as readonly string[]).includes(privilege))
    .map(([table]) => table)
    .sort();

describe('01-grants.sql agrees with the tenant table registry', () => {
  it('parses the lists it is asserting, so a rename cannot make this file vacuous', () => {
    expect(sqlList('no_delete').length + sqlList('append_only').length).toBeGreaterThan(0);
  });

  /**
   * Compared over the tables that exist today, in both directions.
   *
   * `append_only` deliberately names journals that no migration has created yet — the list is
   * written ahead of the tables so a journal cannot land with DELETE granted by default. Those
   * entries have nothing to compare against, so the assertion is the intersection with the
   * registry: every table the registry knows must be classified the same way on both sides.
   */
  it('withholds DELETE in SQL from exactly the tables the registry withholds it from', () => {
    const known = new Set(Object.keys(TENANT_TABLES));
    const inSql = [...sqlList('no_delete'), ...sqlList('append_only')]
      .filter((table) => known.has(table))
      .sort();

    expect(inSql).toEqual(registryTablesWithout('DELETE'));
  });

  /**
   * The same comparison for `UPDATE`, which had nothing checking it until an append-only table
   * existed. `append_only` is the only list that withholds it, so the two sides must name the same
   * tables — a journal that kept `UPDATE` in one place and not the other is a journal whose whole
   * security property depends on which of the two a reader believed.
   */
  it('withholds UPDATE in SQL from exactly the tables the registry withholds it from', () => {
    const known = new Set(Object.keys(TENANT_TABLES));
    const inSql = sqlList('append_only')
      .filter((table) => known.has(table))
      .sort();

    expect(inSql).toEqual(registryTablesWithout('UPDATE'));
  });

  it('names only tables that exist in the registry', () => {
    const known = new Set(Object.keys(TENANT_TABLES));

    expect(sqlList('no_delete').filter((table) => !known.has(table))).toEqual([]);
  });

  /**
   * `definer_reads` is the widest privilege this file grants, and it is the one list nothing was
   * checking.
   *
   * These are the tables `app_auth_definer` may `SELECT`, and that role holds `BYPASSRLS` — the
   * organization predicate does not apply to it. Every name here is therefore a table readable across
   * every tenant from inside a `SECURITY DEFINER` body.
   *
   * Removing a name is caught the loud way: a resolver stops working and the sign-in path fails.
   * **Adding** one is caught by nothing at all — the new table simply becomes cross-tenant readable,
   * no test changes colour, and the next reviewer reads a norm that says «exactly N». So the set is
   * pinned literally rather than derived: a further entry has to be typed here too, next to the
   * reason it is dangerous, which is the whole point of making it inconvenient.
   *
   * `invitations` joined the list in STORY-012-02 and is the one to look at hardest, because it is
   * the only one whose rows are addressed by somebody with **no account at all**: `/invite/<token>`
   * carries a digest and nothing else, so `auth_lookup_invitation` has to find the organization
   * before there is a tenant to scope by. What bounds the exposure is the shape of that function
   * rather than this grant — it returns two ids and neither `accepted_at` nor `expires_at`, so the
   * privileged surface cannot answer «is this invitation still good» for anybody who reached the
   * `app_auth` connection.
   */
  it('grants the BYPASSRLS role SELECT on exactly the tables the org-less resolvers read', () => {
    expect(sqlList('definer_reads').sort()).toEqual([
      'invitations',
      'organizations',
      'password_reset_tokens',
      'sessions',
      'users',
    ]);
  });

  /**
   * The classifier itself. Keying it on a column name is the defect described above; keying it on
   * row-level security is the definition invariant 1 gives. A future edit back to the column form
   * would pass every behavioural test and reintroduce the outage.
   */
  it('classifies a tenant table by row-level security, not by a column name', () => {
    expect(GRANTS_SQL).toMatch(/c\.relrowsecurity AS is_tenant_table/);
    expect(GRANTS_SQL).not.toMatch(/attname = 'organization_id'[\s\S]{0,120}AS is_tenant_table/);
  });
});
