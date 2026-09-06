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
 * What the journal costs the transaction it is written inside — measured against a control.
 *
 * STORY-016-01 acceptance 9 asks that the write «does not become the bottleneck of the transactions
 * it joins», and the reason it is a requirement rather than a nicety is `rules/observability.mdc`
 * §15: the entry goes in **the same transaction** as the change it records. So its cost is not
 * background work an operator can move — it is on the user's path, inside the 150 ms of NFR-2, on
 * every privileged action.
 *
 * ## Why there is a control arm
 *
 * A number for «a transaction that writes an audit row» measures PostgreSQL, the container, the
 * socket and the pool, and the journal's share of it is invisible. Both arms below open the same
 * transaction, pin the same tenant and perform the same ordinary write; one of them additionally
 * inserts the entry. The difference between the two is the only thing here that is about this
 * table, and it is what the runbook quotes.
 *
 * The arms are interleaved rather than run in blocks: a container that warms up, a laptop that
 * changes clock speed and a checkpoint that lands mid-run all bias the second block against the
 * first, and alternating cancels every drift slower than one iteration.
 *
 * ## Two payloads, because they are two different rows
 *
 * A typical entry carries a handful of changed fields; the outlier is a role edit, whose
 * `before`/`after` name permissions from a catalogue of several hundred keys
 * (`docs/runbooks/audit-log.md`: «единицы в месяц, но именно они дают выбросы по размеру»). Both are
 * measured, because a mean over a mixture would describe neither.
 *
 * ## What is asserted
 *
 * The timings live in the comment beside the assertion and in `docs/runbooks/audit-log.md`, with the
 * host they were taken on. Asserting them would make this file fail on a busy machine for reasons
 * that have nothing to do with the journal — and printing them would make every run of the suite
 * noisier for the sake of a number that changes with the laptop. What *is* asserted is the property
 * those numbers depend on and which does not move with the host: the write is one statement into one
 * table with no trigger behind it, and it costs a small fraction of the request budget rather than a
 * multiple of the transaction it joins. Re-measuring means running this file and reading `summarise`
 * under a breakpoint, or printing it for one run and taking the print back out.
 */

let pools: HarnessPools;

const ORG = '00000000-0000-4000-8000-0000000000e1';
const ACTOR = '00000000-0000-4000-8000-0000000000e2';

/** Iterations per arm. Enough for a p50 that does not move between runs; short enough to keep the suite usable. */
const ITERATIONS = 300;

/** Discarded before the statistics: the first transactions pay for a cold cache and a first parse. */
const WARMUP = 30;

/**
 * The request budget of NFR-2, in milliseconds.
 *
 * Quoted here because the answer «0.4 ms» means nothing on its own — what an operator needs is the
 * share of the budget the journal takes from every privileged action.
 */
const REQUEST_BUDGET_MS = 150;

const percentile = (samples: readonly number[], fraction: number): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));

  return sorted[index] as number;
};

const mean = (samples: readonly number[]): number =>
  samples.reduce((total, value) => total + value, 0) / samples.length;

/** A `before`/`after` pair of `keys` fields — the shape of a role edit when `keys` is large. */
const payload = (keys: number): string =>
  JSON.stringify(
    Object.fromEntries(Array.from({ length: keys }, (_, index) => [`permission_${index}`, true])),
  );

/** The ordinary write of a privileged action: one row of domain state, in the tenant's transaction. */
const ORDINARY_WRITE = `UPDATE users SET updated_at = now() WHERE id = $1::uuid`;

const AUDIT_WRITE = `INSERT INTO audit_logs
    (organization_id, actor_id, actor_type, action, resource_type, resource_id,
     before, after, ip_hash, request_id, severity)
  VALUES ($1::uuid, $2::uuid, 'USER', 'role.assigned', 'ROLE', $3::uuid,
          $4::jsonb, $5::jsonb, 'hashed', $6, 'INFO')`;

interface Arm {
  readonly control: number[];
  readonly audited: number[];
}

const runArm = async (withAudit: boolean, keys: number): Promise<number> => {
  const started = process.hrtime.bigint();

  await asTenant(pools.app, ORG, async (client) => {
    await client.query(ORDINARY_WRITE, [ACTOR]);

    if (withAudit) {
      await client.query(AUDIT_WRITE, [
        ORG,
        ACTOR,
        randomUUID(),
        payload(keys),
        payload(keys),
        `req-${randomUUID()}`,
      ]);
    }
  });

  return Number(process.hrtime.bigint() - started) / 1e6;
};

const measure = async (keys: number): Promise<Arm> => {
  const control: number[] = [];
  const audited: number[] = [];

  for (let iteration = 0; iteration < ITERATIONS + WARMUP; iteration += 1) {
    // Interleaved, and the audited arm first on odd iterations, so neither arm is always the one
    // that pays for a cold page.
    const first = iteration % 2 === 0;
    const controlMs = first ? await runArm(false, keys) : 0;
    const auditedMs = await runArm(true, keys);
    const trailingControlMs = first ? 0 : await runArm(false, keys);

    if (iteration >= WARMUP) {
      control.push(first ? controlMs : trailingControlMs);
      audited.push(auditedMs);
    }
  }

  return { control, audited };
};

interface ArmSummary {
  readonly controlMean: number;
  readonly controlP50: number;
  readonly auditedMean: number;
  readonly auditedP50: number;
  readonly auditedP95: number;
  readonly deltaMean: number;
  readonly deltaP50: number;
}

const summarise = (arm: Arm): ArmSummary => ({
  controlMean: Number(mean(arm.control).toFixed(3)),
  controlP50: Number(percentile(arm.control, 0.5).toFixed(3)),
  auditedMean: Number(mean(arm.audited).toFixed(3)),
  auditedP50: Number(percentile(arm.audited, 0.5).toFixed(3)),
  auditedP95: Number(percentile(arm.audited, 0.95).toFixed(3)),
  deltaMean: Number((mean(arm.audited) - mean(arm.control)).toFixed(3)),
  deltaP50: Number((percentile(arm.audited, 0.5) - percentile(arm.control, 0.5)).toFixed(3)),
});

beforeAll(async () => {
  pools = createPools();

  await asMaintenance(pools.owner, async (client) => {
    await client.query(
      `WITH created_organization AS (
         INSERT INTO organizations (id, owner_id, slug, name, updated_at)
         VALUES ($1, $2, 'audit-insert-cost', 'Audit cost fixture', now())
         ON CONFLICT (id) DO NOTHING
         RETURNING id
       )
       INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
       SELECT $2, $1, 'audit-insert-cost@example.test', 'placeholder-not-a-credential', 'ACTIVE', now()
       FROM created_organization`,
      [ORG, ACTOR],
    );
  });
}, 120_000);

afterAll(async () => {
  await asMaintenance(pools.owner, async (client) => {
    await client.query('TRUNCATE TABLE audit_logs, users, organizations RESTART IDENTITY CASCADE');
  });
  await closePools(pools);
});

describe('cost of an audit entry inside the transaction it records', () => {
  it('has no trigger behind it, on the parent or on any partition', async () => {
    const { rows } = await asMaintenance(pools.owner, async (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal
            AND (c.relname = 'audit_logs'
                 OR c.oid IN (SELECT inhrelid FROM pg_inherits
                               WHERE inhparent = 'public.audit_logs'::regclass))`,
      ),
    );

    // Acceptance 9 spells out «one row, no triggers, no computation inside the transaction», and a
    // trigger is the way that stops being true without anybody editing the write path: it would add
    // work to every privileged action in the product, priced nowhere and visible only as latency.
    expect((rows[0] as { count: string }).count).toBe('0');
  });

  it('costs a small fraction of the request budget, typical payload and outlier alike', async () => {
    // Recorded 2026-09-06 on the conditions in the header. Few changed fields: control 3.42 ms
    // mean, audited 4.34 ms, **delta 0.92 ms** — 0.6 % of the 150 ms request budget. A role edit
    // with 331 keys in each of `before` and `after`: control 2.81 ms, audited 4.82 ms, **delta
    // 2.01 ms** — 1.3 %. The table and what moves it: `docs/runbooks/audit-log.md`, «Стоимость
    // записи».
    const typical = summarise(await measure(4));
    const outlier = summarise(await measure(331));

    // The delta, not the absolute: what is under test is the journal, and everything else in the
    // transaction is in both arms. A generous ceiling on purpose — this runs on whatever machine CI
    // was given, and the assertion that has to survive that is «the journal is not what makes a
    // privileged action slow», not a reproduction of the number in the runbook.
    for (const summary of [typical, outlier]) {
      expect(summary.deltaMean).toBeLessThan(REQUEST_BUDGET_MS * 0.2);
      expect(summary.auditedMean).toBeLessThan(summary.controlMean * 3);
    }
  }, 120_000);
});
