import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  TENANT_TABLES,
  type TenantTableName,
  type TenantTableSpec,
} from '@/infrastructure/persistence/prisma/tenant-tables.constant.js';

import {
  asMaintenance,
  asTenant,
  closePools,
  createPools,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';
import { ROW_FACTORIES } from './row-factories.util.js';

/**
 * Tenant isolation, table by table, against a real PostgreSQL.
 *
 * The suite is generated from the registry, so a table added without an entry there is a table
 * nothing asserts about — which is why `tenant-tables.test.ts` compares the registry to the schema.
 *
 * Every block starts with a POSITIVE CONTROL. Without it the whole file is worthless: each negative
 * assertion has the form "the other tenant's row is not there", and all of them are also true when
 * *nothing* is there — a connection under the wrong role, a fixture that failed to insert, a
 * `TRUNCATE` that ran late. The control is the assertion that fails in that case
 * (invariant 1 of CLAUDE.md; rules/tenancy-rls.mdc, 15).
 */

const ORG_A = randomUUID();
const ORG_B = randomUUID();

/** `new row violates row-level security policy` — and also `permission denied`, deliberately. */
const RLS_VIOLATION = '42501';

interface PgError {
  readonly code?: string;
}

const entries = Object.entries(TENANT_TABLES).map(([table, spec]) => ({
  table: table as TenantTableName,
  spec: spec as TenantTableSpec,
}));

let pools: HarnessPools;

beforeAll(() => {
  pools = createPools();
});

afterAll(async () => {
  await closePools(pools);
});

beforeEach(async () => {
  await truncateAll(pools.owner);
  await asMaintenance(pools.owner, async (client) => {
    await ROW_FACTORIES.organizations(client, ORG_A);
    await ROW_FACTORIES.organizations(client, ORG_B);
  });
});

describe('the registry drives this suite', () => {
  it('covers at least the tenant root and one tenant-scoped table', () => {
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });
});

describe.each(entries)('RLS · $table', ({ table, spec }) => {
  let idA: string;
  let idB: string;

  beforeEach(async () => {
    if (table === 'organizations') {
      idA = ORG_A;
      idB = ORG_B;

      return;
    }

    await asMaintenance(pools.owner, async (client) => {
      idA = (await ROW_FACTORIES[table](client, ORG_A)).id;
      idB = (await ROW_FACTORIES[table](client, ORG_B)).id;
    });
  });

  // ── positive controls ───────────────────────────────────────────────────────────────────────

  it('CONTROL: the tenant sees its own row', async () => {
    const rows = await asTenant(
      pools.app,
      ORG_A,
      async (client) => (await client.query(`SELECT id FROM ${table} WHERE id = $1`, [idA])).rows,
    );

    expect(rows).toHaveLength(1);
  });

  it('CONTROL: the tenant may write its own row', async () => {
    const changed = await asTenant(
      pools.app,
      ORG_A,
      async (client) =>
        (await client.query(`UPDATE ${table} SET updated_at = now() WHERE id = $1`, [idA]))
          .rowCount,
    );

    expect(changed).toBe(1);
  });

  it('CONTROL: the owner sees both rows, so the fixtures really exist', async () => {
    const rows = await asMaintenance(
      pools.owner,
      async (client) =>
        (await client.query(`SELECT id FROM ${table} WHERE id = ANY($1::uuid[])`, [[idA, idB]]))
          .rows,
    );

    expect(rows).toHaveLength(2);
  });

  /**
   * The positive control of the *list*, as opposed to the one of the single read above.
   *
   * A bare `SELECT` with no `WHERE` is the shape almost every list endpoint ends up as, and it is
   * the shape where a missing policy shows up as data rather than as an error. The control and the
   * negative below are one pair on purpose: "the list contains my row" and "the list contains
   * nothing else" are different failures — the first is a broken fixture, the second is a leak.
   */
  it('CONTROL: an unfiltered list returns the tenant’s own row', async () => {
    const ids = await asTenant(pools.app, ORG_A, async (client) =>
      (await client.query<{ id: string }>(`SELECT id FROM ${table}`)).rows.map((row) => row.id),
    );

    expect(ids).toContain(idA);
  });

  /**
   * The positive control of the INSERT pair below, and the one this file went without.
   *
   * `RLS_VIOLATION` is `42501`, which PostgreSQL raises both for `new row violates row-level
   * security policy` and for `permission denied for table`. So the negative alone is satisfied by a
   * table on which `app_user` holds no `INSERT` at all — a forgotten `GRANT`, a stray `REVOKE`, or
   * a classifier in `01-grants.sql` that does not recognise the table (which has happened here
   * once already, to `organizations`). The refusal then comes from the privilege and the spec reads
   * it as "the policy worked", while the application cannot write the table at all.
   *
   * This control fails in exactly that case and passes only when the write really reached the
   * policy.
   */
  it.runIf(spec.appUserPrivileges.includes('INSERT'))(
    'CONTROL: the tenant may insert its own row',
    async () => {
      // The tenant root is its own tenant: `WITH CHECK (id = current_setting(...))` admits one id
      // per scope and `idA` already exists, so the control writes a *new* organization through the
      // scope of that organization — the bootstrap path of `docs/security/rls-design.md`.
      const organizationId = table === 'organizations' ? randomUUID() : ORG_A;

      const written = await asTenant(pools.app, organizationId, (client) =>
        ROW_FACTORIES[table](client, organizationId),
      );

      const stored = await asMaintenance(
        pools.owner,
        async (client) =>
          (await client.query(`SELECT id FROM ${table} WHERE id = $1`, [written.id])).rowCount,
      );

      expect(stored).toBe(1);
    },
  );

  it.runIf(spec.appUserPrivileges.includes('DELETE'))(
    'CONTROL: the tenant may delete its own row',
    async () => {
      const deleted = await asTenant(
        pools.app,
        ORG_A,
        async (client) =>
          (await client.query(`DELETE FROM ${table} WHERE id = $1`, [idA])).rowCount,
      );

      expect(deleted).toBe(1);

      const gone = await asMaintenance(
        pools.owner,
        async (client) =>
          (await client.query(`SELECT id FROM ${table} WHERE id = $1`, [idA])).rowCount,
      );

      expect(gone).toBe(0);
    },
  );

  // ── isolation ───────────────────────────────────────────────────────────────────────────────

  it('SELECT: the other tenant’s row is invisible', async () => {
    const rows = await asTenant(
      pools.app,
      ORG_A,
      async (client) => (await client.query(`SELECT id FROM ${table} WHERE id = $1`, [idB])).rows,
    );

    expect(rows).toEqual([]);
  });

  /**
   * The negative half of the list. `COUNT` next door proves the aggregate is filtered; this proves
   * the *rows* are — an important distinction, because a policy that filtered only the aggregate
   * would be invisible to a count-based assertion and would still hand a list endpoint the other
   * tenant's records.
   */
  /**
   * Membership rather than exact equality, and the difference is not a weakening.
   *
   * The assertion used to be `toEqual([idA])`, which held only while every fixture produced exactly one
   * row per tenant. The organization factory now writes an owner beside the organization — it has to,
   * since `organizations.owner_id` became NOT NULL — so `users` legitimately carries two rows for this
   * tenant. Pinning the count would make this test fail on a fixture change instead of on a policy
   * change.
   *
   * What the policy actually promises is asserted directly: the seeded row is visible, and the other
   * tenant's row is not. `idB` is the positive control in the negative direction — a policy that
   * returned everything would fail on it, and a connection with no rows at all would fail on `idA`.
   */
  it('LIST: an unfiltered select returns no row of the other tenant', async () => {
    const ids = await asTenant(pools.app, ORG_A, async (client) =>
      (await client.query<{ id: string }>(`SELECT id FROM ${table}`)).rows.map((row) => row.id),
    );

    expect(ids).toContain(idA);
    expect(ids).not.toContain(idB);
  });

  it('COUNT: an aggregate counts the tenant’s rows and no others', async () => {
    const visible = await asTenant(pools.app, ORG_A, async (client) =>
      Number(
        (await client.query<{ count: string }>(`SELECT count(*) FROM ${table}`)).rows[0]?.count,
      ),
    );
    const total = await asMaintenance(pools.owner, async (client) =>
      Number(
        (await client.query<{ count: string }>(`SELECT count(*) FROM ${table}`)).rows[0]?.count,
      ),
    );

    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThan(total);
  });

  it('INSERT: a row belonging to another tenant is rejected by WITH CHECK', async () => {
    const attempt = asTenant(pools.app, ORG_A, (client) => ROW_FACTORIES[table](client, ORG_B));

    await expect(attempt).rejects.toMatchObject({ code: RLS_VIOLATION });
  });

  it('UPDATE: the other tenant’s row is not reachable', async () => {
    const changed = await asTenant(
      pools.app,
      ORG_A,
      async (client) =>
        (await client.query(`UPDATE ${table} SET updated_at = now() WHERE id = $1`, [idB]))
          .rowCount,
    );

    expect(changed).toBe(0);

    const stillThere = await asMaintenance(
      pools.owner,
      async (client) =>
        (await client.query(`SELECT id FROM ${table} WHERE id = $1`, [idB])).rowCount,
    );

    expect(stillThere).toBe(1);
  });

  it.runIf(spec.tenantColumn === 'organization_id')(
    'UPDATE: a row cannot be moved into another tenant',
    async () => {
      const attempt = asTenant(pools.app, ORG_A, (client) =>
        client.query(`UPDATE ${table} SET organization_id = $1 WHERE id = $2`, [ORG_B, idA]),
      );

      await expect(attempt).rejects.toMatchObject({ code: RLS_VIOLATION });
    },
  );

  it.runIf(spec.appUserPrivileges.includes('DELETE'))(
    'DELETE: the other tenant’s row survives',
    async () => {
      const deleted = await asTenant(
        pools.app,
        ORG_A,
        async (client) =>
          (await client.query(`DELETE FROM ${table} WHERE id = $1`, [idB])).rowCount,
      );

      expect(deleted).toBe(0);

      const survived = await asMaintenance(
        pools.owner,
        async (client) =>
          (await client.query(`SELECT id FROM ${table} WHERE id = $1`, [idB])).rowCount,
      );

      expect(survived).toBe(1);
    },
  );

  it.runIf(!spec.appUserPrivileges.includes('DELETE'))(
    'DELETE: the application is not allowed to delete at all',
    async () => {
      const attempt = asTenant(pools.app, ORG_A, (client) =>
        client.query(`DELETE FROM ${table} WHERE id = $1`, [idA]),
      );

      await expect(attempt).rejects.toMatchObject({ code: RLS_VIOLATION });
    },
  );

  /**
   * A join is where a forgotten `WHERE` usually leaks: the left side is filtered by the query, the
   * right side by nothing. Under RLS both sides carry their own policy, so the row of the other
   * tenant cannot enter the result through either.
   */
  it.runIf(spec.tenantColumn === 'organization_id')(
    'JOIN: the other tenant’s row cannot be pulled in through a relation',
    async () => {
      const rows = await asTenant(
        pools.app,
        ORG_A,
        async (client) =>
          (
            await client.query<{ id: string }>(
              `SELECT t.id
               FROM ${table} t
               JOIN organizations o ON o.id = t.organization_id
              WHERE t.id = ANY($1::uuid[])`,
              [[idA, idB]],
            )
          ).rows,
      );

      expect(rows.map((row) => row.id)).toEqual([idA]);
    },
  );

  /**
   * The most important negative of all: no context must mean *refusal*, not "everything". This is
   * why the policy uses `current_setting('app.organization_id')` and not its two-argument, missing-
   * is-NULL form — the latter would return an empty list, which reads like "no data" and sends a
   * developer looking in the wrong place for a day (docs/security/rls-design.md, «Ловушки», 3).
   */
  it('without a tenant context the query fails instead of returning everything', async () => {
    const client = await pools.app.connect();

    try {
      await client.query('BEGIN');
      await expect(client.query(`SELECT id FROM ${table} LIMIT 1`)).rejects.toSatisfy(
        (error: PgError) => error.code === '42704' || error.code === '22P02',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
