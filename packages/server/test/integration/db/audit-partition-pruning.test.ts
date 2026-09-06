import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asMaintenance,
  asTenant,
  closePools,
  createPools,
  type HarnessPools,
} from './db-harness.util.js';

/**
 * Partitioning and the three indexes, proved by running the queries the product will run.
 *
 * STORY-016-01 acceptance 2 and 7 are the two claims a reader of the migration cannot check:
 * «a query for a period reads only the partitions it needs» and «the three shapes use the three
 * indexes». Both are properties of the *plan*, and a plan is produced by a planner looking at data —
 * so this file seeds the volume first and reads `EXPLAIN (ANALYZE, BUFFERS)` after.
 *
 * ## What the seeding is for, and what it is not for
 *
 * The deferral note in the story said `EXPLAIN` on an empty table «shows one partition simply
 * because there is no data». That is not what happens, and the distinction turned out to matter:
 *
 * - **Pruning is decided before a row is read.** A range filter on the partition key is matched
 *   against each partition's bounds at plan time, so an empty table prunes exactly as a full one
 *   does. Seeding does not make pruning appear.
 * - **Index choice is decided by statistics.** On a partition of a few rows a sequential scan is
 *   cheaper and the planner is right to take it, so acceptance 7 is the half that genuinely cannot
 *   be shown without volume — and the half the deferral was actually about.
 *
 * The seed is therefore sized for the second: {@link ROWS_PER_MONTH} rows in each of
 * {@link SEEDED_MONTHS} months, for two organizations, which is more than an installation of fifty
 * people writes in the same span (`docs/runbooks/audit-log.md`: 1–3 thousand a month) and enough
 * that a sequential scan over a month is no longer the cheap option.
 *
 * ## Why the parameters are bound rather than inlined
 *
 * The product reaches this table through Prisma, which sends bound parameters. A generic plan
 * cannot prune at plan time — it defers to «Subplans Removed» at execution — so an `EXPLAIN` with
 * the dates pasted into the text would be a measurement of a query nobody runs. These are sent the
 * way Prisma sends them, and the assertions below are made about the plan PostgreSQL produced for
 * that.
 *
 * ## What is asserted and what is only measured
 *
 * Asserted: which partitions the plan touches, and which index each shape uses — both stable, both
 * independent of the machine. Pages read are asserted only as a ratio, because the count itself
 * moves with the seed and the row width. The timings are neither asserted nor printed: they belong
 * to the host they were taken on, and they live in the comments beside each case and in
 * `docs/runbooks/audit-log.md` with the conditions attached.
 */

let pools: HarnessPools;

const ORG = '00000000-0000-4000-8000-0000000000c1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000c2';

/** Six months of history: enough for a period filter to have something to exclude. */
const SEEDED_MONTHS = 6;

/**
 * Rows per month per organization.
 *
 * Above the installation this table is sized for — `audit-log.md` estimates 1–3 thousand privileged
 * actions a month for fifty people — because the question here is not «is it fast at our volume»
 * but «does the planner reach for the index at all», and that answer changes with volume.
 */
const ROWS_PER_MONTH = 20_000;

/** `2026-08-01`, the first day of the month `offset` months before the current one. */
const monthStart = (offset: number): Date => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
};

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

const RESOURCE_ID = '00000000-0000-4000-8000-0000000000d1';
const ACTOR_ID = '00000000-0000-4000-8000-0000000000d2';

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Shared Hit Blocks'?: number;
  readonly 'Shared Read Blocks'?: number;
  readonly Plans?: readonly PlanNode[];
}

interface ExplainRow {
  readonly 'QUERY PLAN': readonly [{ readonly Plan: PlanNode; readonly 'Execution Time': number }];
}

interface Plan {
  /** Every partition the plan actually scans, sorted — the answer to «what did it read». */
  readonly partitions: readonly string[];
  /** Every index it scanned them through. */
  readonly indexes: readonly string[];
  /**
   * 8 KiB pages touched by the whole plan — the measure of «how much did it read».
   *
   * The one number a timing cannot replace here: a feed query stops at fifty rows whatever the table
   * looks like, so pruning barely moves its clock, while an aggregate over a period reads every page
   * the plan left in. Blocks say which of the two is happening.
   */
  readonly blocks: number;
  readonly executionMs: number;
}

const walk = (node: PlanNode, visit: (node: PlanNode) => void): void => {
  visit(node);

  for (const child of node.Plans ?? []) {
    walk(child, visit);
  }
};

const explain = async (sql: string, values: readonly unknown[]): Promise<Plan> =>
  asTenant(pools.app, ORG, async (client) => {
    const { rows } = await client.query<ExplainRow>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
      [...values],
    );
    const result = (rows[0] as ExplainRow)['QUERY PLAN'][0];
    const partitions = new Set<string>();
    const indexes = new Set<string>();
    // Buffer counts in `EXPLAIN` are cumulative — a node reports its own pages plus its children's —
    // so the root already holds the total and summing the tree would count the leaves many times.
    const blocks =
      (result.Plan['Shared Hit Blocks'] ?? 0) + (result.Plan['Shared Read Blocks'] ?? 0);

    walk(result.Plan, (node) => {
      const relation = node['Relation Name'];
      const index = node['Index Name'];

      if (relation !== undefined) {
        partitions.add(relation);
      }

      if (index !== undefined) {
        indexes.add(index);
      }
    });

    return {
      partitions: [...partitions].sort(),
      indexes: [...indexes].sort(),
      blocks,
      executionMs: result['Execution Time'],
    };
  });

/** `audit_logs_2026_08` — what `create_audit_partition` names the month of `date`. */
const partitionName = (date: Date): string =>
  `audit_logs_${date.toISOString().slice(0, 7).replace('-', '_')}`;

beforeAll(async () => {
  pools = createPools();

  await asMaintenance(pools.owner, async (client) => {
    for (const organizationId of [ORG, OTHER_ORG]) {
      const ownerId = randomUUID();

      await client.query(
        `WITH created_organization AS (
           INSERT INTO organizations (id, owner_id, slug, name, updated_at)
           VALUES ($1, $2, $3, 'Audit pruning fixture', now())
           ON CONFLICT (id) DO NOTHING
           RETURNING id
         )
         INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
         SELECT $2, $1, $4, 'placeholder-not-a-credential', 'ACTIVE', now()
         FROM created_organization`,
        [
          organizationId,
          ownerId,
          `pruning-${organizationId}`,
          `pruning-${organizationId}@example.test`,
        ],
      );
    }

    // Months before the current one have no partition yet: the migration creates the current month
    // and the two after it, and this fixture reaches backwards.
    for (let offset = 1; offset < SEEDED_MONTHS; offset += 1) {
      await client.query('SELECT create_audit_partition($1::date)', [isoDate(monthStart(offset))]);
    }

    for (let offset = 0; offset < SEEDED_MONTHS; offset += 1) {
      for (const organizationId of [ORG, OTHER_ORG]) {
        await client.query(
          `INSERT INTO audit_logs
             (organization_id, actor_id, actor_type, action, resource_type, resource_id,
              request_id, severity, occurred_at)
           SELECT $1,
                  CASE WHEN i % 50 = 0 THEN $2::uuid ELSE $3::uuid END,
                  'USER',
                  'role.assigned',
                  'ROLE',
                  CASE WHEN i % 50 = 0 THEN $4::uuid ELSE gen_random_uuid() END,
                  'seed-' || i,
                  'INFO',
                  $5::timestamptz + (i % 27) * interval '1 day' + (i % 1000) * interval '1 second'
             FROM generate_series(1, $6::int) AS i`,
          [
            organizationId,
            ACTOR_ID,
            randomUUID(),
            RESOURCE_ID,
            monthStart(offset).toISOString(),
            ROWS_PER_MONTH,
          ],
        );
      }
    }

    await client.query('ANALYZE audit_logs');
  });
}, 300_000);

afterAll(async () => {
  await asMaintenance(pools.owner, async (client) => {
    await client.query('TRUNCATE TABLE audit_logs, users, organizations RESTART IDENTITY CASCADE');
  });
  await closePools(pools);
});

describe('audit_logs partition pruning', () => {
  it('reads only the months the period asks for, and every month without one', async () => {
    const from = monthStart(1);
    const to = monthStart(0);

    const withPeriod = await explain(
      `SELECT id, action, occurred_at FROM audit_logs
        WHERE organization_id = $1::uuid AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz
        ORDER BY occurred_at DESC LIMIT 50`,
      [ORG, from.toISOString(), to.toISOString()],
    );

    const withoutPeriod = await explain(
      `SELECT id, action, occurred_at FROM audit_logs
        WHERE organization_id = $1::uuid
        ORDER BY occurred_at DESC LIMIT 50`,
      [ORG],
    );

    // Recorded 2026-09-06 on the conditions in the header: with the period, one partition,
    // 53 pages, 0.14 ms; without it, nine partitions, 79 pages, 0.26 ms. The nine are the six seeded
    // months, the two created ahead by the migration and the default one.
    expect(withPeriod.partitions).toEqual([partitionName(from)]);
    expect(withoutPeriod.partitions.length).toBeGreaterThan(SEEDED_MONTHS);
  });

  it('reads a month instead of the table when the period is counted, not paged', async () => {
    const from = monthStart(1);
    const to = monthStart(0);

    // The feed above stops at fifty rows whichever partitions are left in the plan, so it is the
    // wrong shape to price pruning with. A count over the period is the shape that pays for every
    // page the planner did not remove — and the shape a journal screen reaches for the moment it
    // shows «N entries» or a chart beside the list.
    const counted = await explain(
      `SELECT count(*) FROM audit_logs
        WHERE organization_id = $1::uuid AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz`,
      [ORG, from.toISOString(), to.toISOString()],
    );

    const countedWhole = await explain(
      `SELECT count(*) FROM audit_logs WHERE organization_id = $1::uuid`,
      [ORG],
    );

    // Recorded 2026-09-06: 728 pages and 7.3 ms for the month, 4 368 pages and 22.7 ms for the
    // table — six times the work at six months of history, and the gap widens with every month
    // that is not detached. `docs/runbooks/audit-log.md`, «Запросы».
    expect(counted.partitions).toEqual([partitionName(from)]);
    // The property, not the ratio: a month is less work than the table, and the number of months is
    // what separates them. The ratio itself lives in the runbook with the conditions it was taken
    // under — it moves with the seed, the page size and the width of the rows.
    expect(counted.blocks * 2).toBeLessThan(countedWhole.blocks);
  });

  it('uses the three indexes for the three shapes', async () => {
    const from = monthStart(1);
    const to = monthStart(0);

    const feed = await explain(
      `SELECT id FROM audit_logs
        WHERE organization_id = $1::uuid AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz
        ORDER BY occurred_at DESC LIMIT 50`,
      [ORG, from.toISOString(), to.toISOString()],
    );

    const resource = await explain(
      `SELECT id FROM audit_logs
        WHERE organization_id = $1::uuid AND resource_type = $2 AND resource_id = $3::uuid
          AND occurred_at >= $4::timestamptz AND occurred_at < $5::timestamptz
        ORDER BY occurred_at DESC LIMIT 50`,
      [ORG, 'ROLE', RESOURCE_ID, from.toISOString(), to.toISOString()],
    );

    const actor = await explain(
      `SELECT id FROM audit_logs
        WHERE organization_id = $1::uuid AND actor_id = $2::uuid
          AND occurred_at >= $3::timestamptz AND occurred_at < $4::timestamptz
        ORDER BY occurred_at DESC LIMIT 50`,
      [ORG, ACTOR_ID, from.toISOString(), to.toISOString()],
    );

    expect(feed.indexes).toEqual([`${partitionName(from)}_organization_id_occurred_at_idx`]);
    expect(resource.indexes.join()).toContain('resource');
    expect(actor.indexes.join()).toContain('actor');
  });
});
