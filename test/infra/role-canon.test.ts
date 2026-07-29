import { describe, expect, it } from 'vitest';

import { EXPECTED_ROLES } from '../../scripts/lib/checks/postgres.check.js';
import { readRepoFile } from '../repo/repo-fixture.util.js';
import { readBootstrapSql, readBootstrapWrapper } from './compose-fixture.util.js';

/**
 * Three artefacts describe the same five roles, and they disagreed.
 *
 * `00-bootstrap-roles.sql` left `app_auth` with `BYPASSRLS`; the role table of
 * `docs/security/rls-design.md` declared it «без `BYPASSRLS`, и без единой табличной привилегии»;
 * `scripts/lib/checks/postgres.check.ts` expected `BYPASSRLS` and did not know `app_auth_definer`
 * existed at all — so the preflight reported "all good" on a cluster where the next migration was
 * guaranteed to fail.
 *
 * None of that broke anything, and that is the property worth a test. The attribute changes no
 * result while the role holds no table privilege; it changes every result the day one is granted,
 * and no behavioural test can tell the difference. So the three are compared as text, here, and
 * `packages/server/test/integration/db/role-catalog.test.ts` compares the winner against a live
 * `pg_roles`.
 */

const RLS_DESIGN_PATH = 'docs/security/rls-design.md';
const RESTORE_RUNBOOK_PATH = 'docs/runbooks/backup-restore.md';

/** `CREATE ROLE app_auth_definer` → `app_auth_definer`, in file order. */
const rolesCreatedByBootstrap = (sql: string): string[] => [
  ...new Set([...sql.matchAll(/\bCREATE\s+ROLE\s+(\w+)/gi)].map((match) => match[1] ?? '')),
];

/** `ALTER ROLE app_auth LOGIN NOINHERIT … BYPASSRLS;` → `app_auth` ⇒ true. */
const bypassRlsInBootstrap = (sql: string): Map<string, boolean> => {
  const attributes = new Map<string, boolean>();

  for (const [, role, tail] of sql.matchAll(/^ALTER ROLE\s+(\w+)\s+((?:NO)?LOGIN[^;]*);/gm)) {
    if (/\bNOBYPASSRLS\b/.test(tail ?? '')) attributes.set(role ?? '', false);
    else if (/\bBYPASSRLS\b/.test(tail ?? '')) attributes.set(role ?? '', true);
  }

  return attributes;
};

/**
 * The RLS column of the role table in `rls-design.md`, per role.
 *
 * The table is the canon a reviewer reads, so it is parsed rather than paraphrased: a row saying
 * «без `BYPASSRLS`» and a bootstrap saying `BYPASSRLS` is precisely the drift this file exists for.
 */
const bypassRlsInDesignDoc = (markdown: string): Map<string, boolean> => {
  const claims = new Map<string, boolean>();

  for (const [, role, cell] of markdown.matchAll(
    /^\|\s*`(app_\w+|backup_role)`\s*\|[^|]*\|([^|]*)\|/gm,
  )) {
    const text = cell ?? '';
    const denies = /без\s+`?BYPASSRLS|`?BYPASSRLS`?\s+нет|NOBYPASSRLS/i.test(text);

    claims.set(role ?? '', !denies && /BYPASSRLS/.test(text));
  }

  return claims;
};

describe('the five roles, as three artefacts describe them', () => {
  const bootstrap = bypassRlsInBootstrap(readBootstrapSql());
  const design = bypassRlsInDesignDoc(readRepoFile(RLS_DESIGN_PATH));

  it('names all five roles in every artefact', () => {
    const roles = [...bootstrap.keys()].sort();

    expect(roles).toEqual([
      'app_auth',
      'app_auth_definer',
      'app_migrator',
      'app_user',
      'backup_role',
    ]);
    expect([...design.keys()].sort()).toEqual(roles);
    expect(EXPECTED_ROLES.map((role) => role.role).sort()).toEqual(roles);
  });

  it.each([...bootstrap.keys()].sort())('%s carries the same BYPASSRLS in all three', (role) => {
    const inBootstrap = bootstrap.get(role);

    expect(design.get(role), `${RLS_DESIGN_PATH} disagrees with the bootstrap about ${role}`).toBe(
      inBootstrap,
    );
    expect(
      EXPECTED_ROLES.find((expected) => expected.role === role)?.bypassRls,
      `the preflight check disagrees with the bootstrap about ${role}`,
    ).toBe(inBootstrap);
  });

  /**
   * `app_auth_definer` is `NOLOGIN` and the preflight asserts `rolcanlogin` — so the expectation has
   * to carry the distinction, or the check fails on a correctly bootstrapped cluster.
   */
  it('knows which roles are meant to log in', () => {
    const nologin = EXPECTED_ROLES.filter((role) => role.canLogin === false).map(
      (role) => role.role,
    );

    expect(nologin).toEqual(['app_auth_definer']);
    expect(readBootstrapSql()).toMatch(/ALTER ROLE app_auth_definer NOLOGIN/);
  });
});

/**
 * The two places that tell an operator, in prose, what the bootstrap creates.
 *
 * `app_auth_definer` was added by EPIC-006 as a fifth role, and both of these kept saying four. That
 * is not a typo with no consequence: the restore runbook is read while a database is down, and the
 * line it reads is the checklist of what must exist before `pg_restore`. A role missing from the
 * list is a role nobody verifies, and the failure surfaces two steps later as
 * `role "app_auth_definer" does not exist` in the middle of a restore.
 *
 * Both are held against the SQL rather than against a number, so the next role added is named here
 * on the day it is written.
 */
describe('the prose that enumerates the roles', () => {
  const roles = rolesCreatedByBootstrap(readBootstrapSql());

  it('reads a non-empty list of roles to check against', () => {
    expect(roles.length).toBeGreaterThan(1);
  });

  it.each(roles)('names %s in the line the bootstrap script prints', (role) => {
    const [echoed] = readBootstrapWrapper().match(/^echo "bootstrap-roles:.*$/m) ?? [];

    expect(echoed, 'the bootstrap wrapper prints no summary line').toBeDefined();
    expect(echoed ?? '').toContain(role);
  });

  it.each(roles)('names %s in the restore procedure of the runbook', (role) => {
    expect(readRepoFile(RESTORE_RUNBOOK_PATH)).toContain(role);
  });

  it('does not miscount the roles in the restore runbook', () => {
    const runbook = readRepoFile(RESTORE_RUNBOOK_PATH);
    const counted = /(четыре|четырёх|пять|пяти|шесть|шести)\s+рол/gi;

    const words: Record<string, number> = {
      четыре: 4,
      четырёх: 4,
      пять: 5,
      пяти: 5,
      шесть: 6,
      шести: 6,
    };

    for (const [, word] of runbook.matchAll(counted)) {
      expect(
        words[(word ?? '').toLowerCase()],
        `the runbook says «${word} рол…» while the bootstrap creates ${roles.length}`,
      ).toBe(roles.length);
    }
  });
});
