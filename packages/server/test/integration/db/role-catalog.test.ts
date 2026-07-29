import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePools, createPools, type HarnessPools } from './db-harness.util.js';

/**
 * The five roles, read out of `pg_roles` rather than inferred from behaviour.
 *
 * Behaviour cannot see this class of defect at all. `app_auth` carried `BYPASSRLS` while the role
 * table of `docs/security/rls-design.md` declared it «без `BYPASSRLS`, и без единой табличной
 * привилегии» — and every test stayed green, because the role holds no table privilege, so there is
 * no query whose result the attribute changes. It becomes visible on the day somebody adds a
 * `GRANT … TO app_auth`: that grant is then a cross-tenant read of the whole installation, and it
 * still breaks no test.
 *
 * So the assertion is about the catalog. The resolvers execute as `app_auth_definer`, which is the
 * role that needs `BYPASSRLS`; the connecting role needs none, and `auth-lookup-path.test.ts` proves
 * the three functions keep working without it.
 */

let pools: HarnessPools;

interface RoleFact {
  readonly rolname: string;
  readonly rolcanlogin: boolean;
  readonly rolbypassrls: boolean;
  readonly rolsuper: boolean;
  readonly rolinherit: boolean;
  readonly rolcreaterole: boolean;
  readonly rolcreatedb: boolean;
}

/**
 * `docs/security/rls-design.md`, «Четыре роли и почему именно четыре», as data.
 *
 * Five rows for four jobs: the authentication path is two roles because a `SECURITY DEFINER`
 * function runs with its **owner's** privileges, and the owner therefore needs `SELECT` on the
 * tables it reads — which is exactly what the connecting role must not have.
 */
const CANON: readonly {
  readonly role: string;
  readonly canLogin: boolean;
  readonly bypassRls: boolean;
  readonly why: string;
}[] = [
  { role: 'app_auth', canLogin: true, bypassRls: false, why: 'holds EXECUTE and nothing else' },
  {
    role: 'app_auth_definer',
    canLogin: false,
    bypassRls: true,
    why: 'the resolvers run as this role, and they read across organizations by design',
  },
  {
    role: 'app_migrator',
    canLogin: true,
    bypassRls: false,
    why: 'owns the schema, under FORCE RLS',
  },
  { role: 'app_user', canLogin: true, bypassRls: false, why: 'serves requests under RLS' },
  { role: 'backup_role', canLogin: true, bypassRls: true, why: 'pg_dump under FORCE RLS' },
];

beforeAll(() => {
  pools = createPools();
});

afterAll(async () => {
  await closePools(pools);
});

const roleFacts = async (): Promise<RoleFact[]> => {
  const { rows } = await pools.owner.query<RoleFact>(
    `SELECT rolname, rolcanlogin, rolbypassrls, rolsuper, rolinherit, rolcreaterole, rolcreatedb
       FROM   pg_roles
      WHERE   rolname LIKE 'app\\_%' OR rolname = 'backup_role'
      ORDER   BY rolname`,
  );

  return rows;
};

describe('the role catalog against docs/security/rls-design.md', () => {
  it('has exactly the five roles the bootstrap creates, and no more', async () => {
    expect((await roleFacts()).map((row) => row.rolname)).toEqual(CANON.map((row) => row.role));
  });

  it.each(CANON)('$role: BYPASSRLS is $bypassRls — $why', async ({ role, bypassRls }) => {
    const fact = (await roleFacts()).find((row) => row.rolname === role);

    expect(fact, `role ${role} does not exist`).toBeDefined();
    expect(fact?.rolbypassrls).toBe(bypassRls);
  });

  it.each(CANON)('$role: LOGIN is $canLogin', async ({ role, canLogin }) => {
    expect((await roleFacts()).find((row) => row.rolname === role)?.rolcanlogin).toBe(canLogin);
  });

  /**
   * The attributes that are the same for all five, and the reason they are asserted together: any
   * one of them is a way back to the privileges the split exists to keep apart. `NOINHERIT` in
   * particular is what makes the one sanctioned membership — app_migrator in app_auth_definer,
   * needed for `ALTER FUNCTION … OWNER TO` — cost nothing until a statement asks for it.
   */
  it.each(CANON)(
    '$role: is no superuser, creates no role and no database, NOINHERIT',
    async ({ role }) => {
      const fact = (await roleFacts()).find((row) => row.rolname === role);

      expect(fact?.rolsuper, `${role} is a superuser`).toBe(false);
      expect(fact?.rolcreaterole, `${role} may create roles`).toBe(false);
      expect(fact?.rolcreatedb, `${role} may create databases`).toBe(false);
      expect(fact?.rolinherit, `${role} inherits the rights of roles it is a member of`).toBe(
        false,
      );
    },
  );

  /**
   * `app_auth` is the credential a reachable service holds, so the assertion is not only "no table
   * privilege today" but "no path to one": no membership, and nothing in `relacl` anywhere.
   */
  it('gives app_auth no privilege on any table, view or sequence', async () => {
    const { rows } = await pools.owner.query<{ object: string; privileges: string }>(
      `SELECT c.relname AS object, array_to_string(c.relacl, ',') AS privileges
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relacl::text LIKE '%app_auth=%'
          AND c.relacl::text NOT LIKE '%app_auth_definer=%'`,
    );

    expect(rows).toEqual([]);
  });

  it('makes nobody a member of anything, except the migrator of the definer', async () => {
    const { rows } = await pools.owner.query<{ member: string; granted: string }>(
      `SELECT member.rolname AS member, granted.rolname AS granted
         FROM pg_auth_members am
         JOIN pg_roles granted ON granted.oid = am.roleid
         JOIN pg_roles member  ON member.oid  = am.member
        WHERE granted.rolname IN ('app_migrator','app_user','app_auth','app_auth_definer','backup_role')
          AND member.rolname  IN ('app_migrator','app_user','app_auth','app_auth_definer','backup_role')
        ORDER BY member, granted`,
    );

    expect(rows).toEqual([{ member: 'app_migrator', granted: 'app_auth_definer' }]);
  });
});
