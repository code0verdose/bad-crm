import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PARTITION_ROW_SECURITY_SQL,
  POLICIES_SQL,
} from '@/infrastructure/persistence/prisma/rls-catalog.constant.js';

import {
  asMaintenance,
  asTenant,
  closePools,
  createPools,
  type HarnessPools,
} from './db-harness.util.js';

/**
 * The audit trail cannot be rewritten by the application — asserted against the privileges, not
 * against the code that is supposed to respect them.
 *
 * `T-PLAT-05` («подделка аудит-лога») is about an attacker who already runs inside the process: a
 * rule they could ignore is not a mitigation. What stops them is that the connection the application
 * holds has no `UPDATE`, `DELETE` or `TRUNCATE` on this table — so the assertions here are made by
 * *trying*, as `app_user`, and by reading `information_schema` afterwards.
 *
 * Partitioning is what makes this more than one check. Privileges are not inherited by partitions,
 * and a leaf reachable by `app_user` would be a leaf with its own answer to every question below —
 * so every partition is enumerated rather than the parent alone, and a partition created after this
 * file was written is included by construction.
 */

let pools: HarnessPools;

const ORG = '00000000-0000-4000-8000-0000000000a1';
const INSUFFICIENT_PRIVILEGE = '42501';

interface PartitionSecurity {
  readonly table_name: string;
  readonly rls_enabled: boolean;
  readonly rls_forced: boolean;
}

/**
 * Every partition of `audit_logs`, whatever the month, plus the default one — read through the
 * shared catalog query rather than through one written here.
 *
 * `rls-catalog-sources.test.ts` enforces that: the columns that say whether isolation is on may be
 * named in exactly one module, because a second copy of the query is a second definition of what
 * «protected» means, and the copy that is wrong is the one nobody ran.
 */
const partitionSecurity = async (): Promise<PartitionSecurity[]> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<PartitionSecurity>(PARTITION_ROW_SECURITY_SQL, [
      'audit_logs',
    ]);

    return rows;
  });

const partitionsOf = async (): Promise<string[]> =>
  (await partitionSecurity()).map((row) => row.table_name);

const writeEntry = async (organizationId: string): Promise<string> =>
  asTenant(pools.app, organizationId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO audit_logs
         (organization_id, actor_type, action, resource_type, request_id, severity)
       VALUES ($1, 'SYSTEM', 'test.written', 'FIXTURE', $2, 'INFO')
       RETURNING id`,
      [organizationId, `req-${randomUUID()}`],
    );

    return (rows[0] as { id: string }).id;
  });

beforeAll(async () => {
  pools = createPools();

  await asMaintenance(pools.owner, async (client) => {
    const ownerId = randomUUID();

    await client.query(
      `WITH created_organization AS (
         INSERT INTO organizations (id, owner_id, slug, name, updated_at)
         VALUES ($1, $2, $3, 'Audit fixture', now())
         ON CONFLICT (id) DO NOTHING
         RETURNING id
       )
       INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
       SELECT $2, $1, $4, 'placeholder-not-a-credential', 'ACTIVE', now()
       FROM created_organization`,
      [
        ORG,
        ownerId,
        `audit-${ORG.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
        `owner-${ownerId}@example.test`,
      ],
    );
  });
});

afterAll(async () => {
  await closePools(pools);
});

describe('what the application may do with the audit trail', () => {
  it('CONTROL: writes an entry and reads it back, so the refusals below mean something', async () => {
    const id = await writeEntry(ORG);

    const rows = await asTenant(
      pools.app,
      ORG,
      async (client) => (await client.query(`SELECT id FROM audit_logs WHERE id = $1`, [id])).rows,
    );

    expect(rows).toHaveLength(1);
  });

  it('cannot change an entry it wrote a moment ago', async () => {
    const id = await writeEntry(ORG);

    const attempt = asTenant(pools.app, ORG, (client) =>
      client.query(`UPDATE audit_logs SET action = 'tampered' WHERE id = $1`, [id]),
    );

    await expect(attempt).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it('cannot delete an entry, and cannot empty the table', async () => {
    const id = await writeEntry(ORG);

    await expect(
      asTenant(pools.app, ORG, (client) =>
        client.query(`DELETE FROM audit_logs WHERE id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });

    // TRUNCATE ignores row-level security entirely, so it is the one statement that would empty the
    // trail for every organization at once. It is never granted anywhere in this schema.
    await expect(
      asTenant(pools.app, ORG, (client) => client.query(`TRUNCATE audit_logs`)),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it('cannot reach a partition directly, whichever one it is', async () => {
    const partitions = await partitionsOf();

    // CONTROL: the parent has partitions at all. Against an empty list every assertion below passes
    // and this file would report that a table with no storage is well protected.
    expect(partitions.length).toBeGreaterThan(1);

    for (const partition of partitions) {
      await expect(
        asTenant(pools.app, ORG, (client) => client.query(`SELECT 1 FROM ${partition} LIMIT 1`)),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    }
  });
});

describe('the privileges recorded in the catalogue', () => {
  it('gives the application INSERT and SELECT on the trail and nothing else', async () => {
    const held = await asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{ privilege_type: string }>(
        `SELECT privilege_type
           FROM information_schema.role_table_grants
          WHERE grantee = 'app_user' AND table_name = 'audit_logs'
          ORDER BY privilege_type`,
      );

      return rows.map((row) => row.privilege_type);
    });

    expect(held).toEqual(['INSERT', 'SELECT']);
  });

  it('gives the application nothing at all on any partition', async () => {
    const partitions = await partitionsOf();

    const granted = await asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type
           FROM information_schema.role_table_grants
          WHERE grantee = 'app_user' AND table_name = ANY($1::text[])`,
        [partitions],
      );

      return rows;
    });

    expect(partitions.length).toBeGreaterThan(1);
    expect(granted).toEqual([]);
  });

  /**
   * A partition created after this test was written — by the job, by an operator, by a future
   * migration — has to arrive with the same protections, because nothing re-applies them per row.
   * Created here through the same function every other caller uses, which is what makes the answer
   * about the function rather than about one month somebody remembered to configure.
   */
  it('applies isolation and the revocation to a partition created later', async () => {
    const created = await asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{ create_audit_partition: string }>(
        `SELECT create_audit_partition(date '2099-01-01')`,
      );

      return (rows[0] as { create_audit_partition: string }).create_audit_partition;
    });

    expect(created).toBe('audit_logs_2099_01');

    const security = (await partitionSecurity()).find((row) => row.table_name === created);
    const policies = await asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{ table_name: string; policy_name: string }>(
        POLICIES_SQL,
      );

      return rows.filter((row) => row.table_name === created);
    });
    const grants = await asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{ grantee: string }>(
        `SELECT grantee
           FROM information_schema.role_table_grants
          WHERE table_name = $1`,
        [created],
      );

      return rows.map((row) => row.grantee);
    });

    expect(security).toMatchObject({ rls_enabled: true, rls_forced: true });
    expect(policies.map((policy) => policy.policy_name).sort()).toEqual([
      'maintenance_access',
      'tenant_isolation',
    ]);
    expect(grants).not.toContain('app_user');
    // The backup reads partition by partition and stops on the first one it may not open, so a new
    // month without this grant breaks `pg_dump` rather than the application — silently, until the
    // next backup.
    expect(grants).toContain('backup_role');

    await asMaintenance(pools.owner, (client) =>
      client.query(`DROP TABLE IF EXISTS audit_logs_2099_01`),
    );
  });

  it('refuses to let the application detach or drop a partition', async () => {
    const attempt = asTenant(pools.app, ORG, (client) =>
      client.query(`ALTER TABLE audit_logs DETACH PARTITION audit_logs_default`),
    );

    await expect(attempt).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });
});
