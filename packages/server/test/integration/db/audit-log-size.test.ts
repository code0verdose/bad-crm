import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUDIT_LOG_BYTES_SQL } from '@/infrastructure/persistence/prisma/audit-log-size.adapter.js';

import { asMaintenance, closePools, createPools, type HarnessPools } from './db-harness.util.js';

/**
 * The number behind `audit_log_partition_bytes`, read by the role the API process actually holds.
 *
 * The metric answers acceptance 10 — «an operator sees the journal grow before the disk ends» — and
 * the only interesting question about it is a privilege one. `app_user` has `REVOKE ALL` on every
 * partition (that is what makes the trail append-only), so a size query written against the leaves
 * looks exactly like a query that will fail in production and pass nowhere else. It does not fail,
 * and the reason is worth stating: `pg_total_relation_size` reads the catalogue and the files behind
 * it, and needs no privilege on the relation it is asked about.
 *
 * Which is precisely why this is asserted against a live database and as `app_user`, rather than
 * reasoned about here.
 */

let pools: HarnessPools;
let app: Pool;

const ORG = '00000000-0000-4000-8000-0000000000f1';

const readBytes = async (pool: Pool): Promise<number> => {
  const { rows } = await pool.query<{ bytes: string }>(AUDIT_LOG_BYTES_SQL);

  return Number((rows[0] as { bytes: string }).bytes);
};

const insertEntries = async (count: number): Promise<void> => {
  await asMaintenance(pools.owner, async (client) => {
    await client.query(
      `INSERT INTO audit_logs
         (organization_id, actor_type, action, resource_type, request_id, severity)
       SELECT $1::uuid, 'SYSTEM', 'test.written', 'FIXTURE', 'req-' || i, 'INFO'
         FROM generate_series(1, $2::int) AS i`,
      [ORG, count],
    );
  });
};

beforeAll(async () => {
  pools = createPools();
  app = pools.app;

  await asMaintenance(pools.owner, async (client) => {
    const ownerId = randomUUID();

    await client.query(
      `WITH created_organization AS (
         INSERT INTO organizations (id, owner_id, slug, name, updated_at)
         VALUES ($1, $2, 'audit-log-size', 'Audit size fixture', now())
         ON CONFLICT (id) DO NOTHING
         RETURNING id
       )
       INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
       SELECT $2, $1, 'audit-log-size@example.test', 'placeholder-not-a-credential', 'ACTIVE', now()
       FROM created_organization`,
      [ORG, ownerId],
    );
  });
}, 120_000);

afterAll(async () => {
  await asMaintenance(pools.owner, async (client) => {
    await client.query('TRUNCATE TABLE audit_logs, users, organizations RESTART IDENTITY CASCADE');
  });
  await closePools(pools);
});

describe('the on-disk size of the audit trail', () => {
  it('is readable by the role the application connects as, which owns none of the partitions', async () => {
    await insertEntries(20_000);

    const bytes = await readBytes(app);

    // Recorded 2026-09-06: 4.06 MB for 20 000 minimal entries with their three indexes, about
    // 205 bytes each (`docs/runbooks/audit-log.md`, «Объём и рост»).
    expect(bytes).toBeGreaterThan(0);
  });

  it('grows with the trail — POSITIVE CONTROL for the reading above', async () => {
    const before = await readBytes(app);

    await insertEntries(40_000);

    const after = await readBytes(app);

    // Without this the first test passes against a query that returns a constant — the size of an
    // unrelated relation, or a sum over an empty set that happens to be non-zero somewhere else.
    expect(after).toBeGreaterThan(before);
  });

  it('costs a catalogue lookup, which is what the cache window is sized against', async () => {
    const samples: number[] = [];

    for (let iteration = 0; iteration < 20; iteration += 1) {
      const started = process.hrtime.bigint();

      await readBytes(app);
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }

    const sorted = [...samples].sort((left, right) => left - right);

    // Recorded 2026-09-06 over ten partitions: p50 0.48 ms, max 2.30 ms.
    // The property, not the number: this is a catalogue lookup and a stat of the files behind it, so
    // it stays in the order of a `SELECT 1` and never becomes a scan. It is served to whoever
    // scrapes, so «cheap» is what makes a one-minute cache window a courtesy rather than a necessity
    // — and a change that made it a scan is what this would catch.
    expect(sorted[10] as number).toBeLessThan(50);
  });

  it('counts the partitions and not the parent, which stores nothing', async () => {
    const { rows } = await app.query<{ parent: string; partitions: string }>(
      `SELECT pg_total_relation_size('public.audit_logs'::regclass)::text AS parent,
              (${AUDIT_LOG_BYTES_SQL.replace(/;$/, '')}) AS partitions`,
    );
    const { parent, partitions } = rows[0] as { parent: string; partitions: string };

    // Recorded 2026-09-06: the parent answered 0 bytes while its partitions held 11 542 528.
    // The trap this guards against: `pg_total_relation_size` on a partitioned parent reports the
    // parent's own storage, which is nothing at all. A metric written that way reads zero for the
    // life of the installation and alerts on nothing.
    expect(Number(partitions)).toBeGreaterThan(Number(parent));
  });
});
