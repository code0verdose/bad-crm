import { describe, expect, it } from 'vitest';

import {
  OWNER_DB_ROLE,
  RUNTIME_DB_ROLE,
  UnsafeDatabaseRoleError,
  assertRuntimeDbRole,
  databaseRoleViolations,
  type DbRoleFacts,
} from '@/infrastructure/persistence/prisma/assert-db-role.util.js';

/**
 * The startup check that decides whether tenant isolation is in force at all.
 *
 * Every fact below describes a connection on which the policies of invariant 1 silently do nothing:
 * a superuser and a `BYPASSRLS` role skip them outright, the schema owner skips them whenever a
 * table is missing `FORCE ROW LEVEL SECURITY`, and a role that can `SET ROLE app_migrator` is one
 * statement away from becoming the owner. None of it is visible from the application — every query
 * succeeds, every test passes, and the rows of every organization are readable.
 *
 * So it is checked once, before the port is open, and the branches are asserted here rather than
 * against a container: a database can be misconfigured in one way per run, and this suite has to
 * cover all five.
 */

const safeFacts = (overrides: Partial<DbRoleFacts> = {}): DbRoleFacts => ({
  role: RUNTIME_DB_ROLE,
  isSuperuser: false,
  bypassesRls: false,
  ownsSchema: false,
  canBecomeOwner: false,
  ...overrides,
});

interface FakeProbe {
  readonly queries: string[];
  readonly values: unknown[][];
  readonly client: Parameters<typeof assertRuntimeDbRole>[0];
}

const fakeProbe = (rows: unknown[]): FakeProbe => {
  const queries: string[] = [];
  const values: unknown[][] = [];

  return {
    queries,
    values,
    client: {
      $queryRaw: (fragments: TemplateStringsArray, ...bound: unknown[]): Promise<unknown> => {
        queries.push(fragments.join('?'));
        values.push(bound);

        return Promise.resolve(rows);
      },
    } as unknown as Parameters<typeof assertRuntimeDbRole>[0],
  };
};

describe('databaseRoleViolations', () => {
  it('CONTROL: accepts the role the application is meant to run as', () => {
    expect(databaseRoleViolations(safeFacts())).toEqual([]);
  });

  it('rejects a connection made as the schema owner and names both roles', () => {
    const violations = databaseRoleViolations(safeFacts({ role: OWNER_DB_ROLE }));

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(RUNTIME_DB_ROLE);
    expect(violations[0]).toContain(OWNER_DB_ROLE);
  });

  it('rejects a role that bypasses row level security', () => {
    expect(databaseRoleViolations(safeFacts({ bypassesRls: true })).join('\n')).toContain(
      'BYPASSRLS',
    );
  });

  it('rejects a superuser, for which no policy applies either', () => {
    expect(databaseRoleViolations(safeFacts({ isSuperuser: true })).join('\n')).toContain(
      'superuser',
    );
  });

  it('rejects the owner of schema public even when it is called app_user', () => {
    expect(databaseRoleViolations(safeFacts({ ownsSchema: true })).join('\n')).toContain('owns');
  });

  it('rejects a role that can SET ROLE into the owner', () => {
    expect(databaseRoleViolations(safeFacts({ canBecomeOwner: true })).join('\n')).toContain(
      'SET ROLE',
    );
  });

  it('reports every problem at once, so a misconfiguration is fixed in one pass', () => {
    const violations = databaseRoleViolations(
      safeFacts({ role: OWNER_DB_ROLE, bypassesRls: true, isSuperuser: true, ownsSchema: true }),
    );

    expect(violations).toHaveLength(4);
  });
});

describe('assertRuntimeDbRole', () => {
  it('CONTROL: returns the facts and asks the catalog for them', async () => {
    const probe = fakeProbe([
      {
        role: RUNTIME_DB_ROLE,
        is_superuser: false,
        bypasses_rls: false,
        owns_schema: false,
        can_become_owner: false,
      },
    ]);

    await expect(assertRuntimeDbRole(probe.client)).resolves.toEqual(safeFacts());
    expect(probe.queries.join('\n')).toContain('rolbypassrls');
  });

  it('refuses to continue on an unsafe role, carrying every reason', async () => {
    const probe = fakeProbe([
      {
        role: OWNER_DB_ROLE,
        is_superuser: false,
        bypasses_rls: true,
        owns_schema: true,
        can_become_owner: false,
      },
    ]);

    const error = await assertRuntimeDbRole(probe.client).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnsafeDatabaseRoleError);
    expect((error as UnsafeDatabaseRoleError).reasons).toHaveLength(3);
    expect((error as Error).message).toContain('BYPASSRLS');
  });

  /**
   * A probe that answers nothing is not a pass. `pg_roles` is readable by every role, so an empty
   * result means the query did not run the way this module thinks it does — and "no facts" must
   * never be read as "no problems".
   */
  it('refuses when the catalog answers with no row at all', async () => {
    await expect(assertRuntimeDbRole(fakeProbe([]).client)).rejects.toBeInstanceOf(
      UnsafeDatabaseRoleError,
    );
  });

  /**
   * The one value in the statement is a bind parameter, not text.
   *
   * It is a constant of this module rather than user input, so nothing is exploitable today — but
   * `to_regrole('…')` written by concatenation is the shape the next role name gets copied into,
   * and the next one may come from configuration. The property is cheap to keep and impossible to
   * observe once it is gone (rules/tenancy-rls.mdc, 10).
   */
  it('binds the owner role as a parameter instead of writing it into the SQL', async () => {
    const probe = fakeProbe([
      {
        role: RUNTIME_DB_ROLE,
        is_superuser: false,
        bypasses_rls: false,
        owns_schema: false,
        can_become_owner: false,
      },
    ]);

    await assertRuntimeDbRole(probe.client);

    expect(probe.values[0]).toEqual([OWNER_DB_ROLE]);
    expect(probe.queries[0]).not.toContain(OWNER_DB_ROLE);
  });
});
