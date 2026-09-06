import { randomBytes } from 'node:crypto';

import { type PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { SharedPermissions } from '@bad-crm/shared';

import { type AuditEvent } from '@/application/platform/ports/audit-logger.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import { HmacAddressHasher } from '@/infrastructure/crypto/address-hasher.adapter.js';
import { degradingAuditLogger } from '@/infrastructure/logging/degrading-audit-logger.adapter.js';
import { countedAuditLogger } from '@/infrastructure/metrics/counted-audit-logger.adapter.js';
import { createPromMetrics } from '@/infrastructure/metrics/prom-client.adapter.js';
import { PrismaAuditLogger } from '@/infrastructure/persistence/prisma/audit-log.adapter.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * What the port itself costs, with the database taken out — STORY-016-02, acceptance 10.
 *
 * `test/integration/db/audit-insert-cost.test.ts` prices the **insert**: one statement into one
 * partitioned table, against a control transaction without it. This file prices everything the
 * chain does around that statement — the redaction walk over `before`/`after`
 * (`audit-redaction.util.ts`, run on every event), the severity lookup, `actorType`, the keyed hash
 * of the address, the savepoint decision, the two decorators — by running the real chain against a
 * transaction whose insert resolves at once. The two numbers add: the insert is what the database
 * charges, this is what the process charges before asking it.
 *
 * ## Why a control arm, here too
 *
 * The audited arm awaits a fake insert, and so does the control: the same `create`, with the same
 * payload objects, from inside the same tenant scope. What the control does not do is go through
 * the port. The difference is the port, and nothing else in the loop — promise scheduling, the fake,
 * the scope — is in it. Arms are interleaved, as in the insert test, so a garbage-collection pause
 * or a clock change lands on both.
 *
 * ## Two payloads, the same two as the insert test
 *
 * A typical event carries a handful of changed fields. The outlier is a role edit, whose
 * `before`/`after` each name the permissions the role grants — the whole catalogue in the worst
 * case (`write-custom-role.use-case.ts`: «the whole set, not the additions») — and the redaction
 * walk visits every one of those strings and tests each against the value shapes. If anything here
 * is expensive, it is that, so it is the case measured rather than the one that would look good.
 *
 * ## What is asserted, and on which statistic
 *
 * The numbers live in the comment beside the assertion and in `docs/runbooks/audit-log.md` with the
 * host and the conditions they were taken on; asserting them would fail on a busy CI worker for
 * reasons unrelated to the port. What is asserted is the property they support and which does not
 * move with the host: the port's own work is a small fraction of what the insert it precedes costs,
 * and a negligible share of the request budget.
 *
 * The two absolute ceilings are on the **p50** delta, not the mean. A mean over two thousand
 * in-process microseconds is moved by one pause — a garbage collection, a scheduler hiccup of a few
 * hundred milliseconds on a shared CI worker — enough to clear a ceiling set an order of magnitude
 * above the recorded figure, and the `checks` gate then fails on nothing the port did. The median
 * does not see the pause. The relative ceiling stays on the mean: it is the property itself, and
 * a fortieth of a millisecond against a hundred and fifty stays true through any pause.
 *
 * ## Conditions of the recorded figures
 *
 * `vitest run --coverage.enabled=false`. That is not what `pnpm test` in this package does — its
 * `vitest.config.ts` enables v8 coverage — and under instrumentation every function of the chain
 * is counted on entry, so the figures the gate sees are higher than the ones recorded below. The
 * ceilings are set for the instrumented run; the figures are recorded for the bare one, because
 * that is what the process ships. Re-measuring means reading `summarise` under a breakpoint, or
 * printing it for one run and taking the print back out — with the flag.
 */

const ORG = '00000000-0000-4000-8000-000000000c11';
const ACTOR = '00000000-0000-4000-8000-000000000c12';

/** Iterations per arm. In-process microseconds, so thousands are cheap and the p50 is steady. */
const ITERATIONS = 2_000;
/** Discarded first: JIT warm-up, first allocation of the regexes, first hash. */
const WARMUP = 200;

/** The request budget of NFR-2 in milliseconds, so a microsecond figure has something to be a share of. */
const REQUEST_BUDGET_MS = 150;

const silent: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: (): LoggerPort => silent,
};

const requestContext: RequestContextPort = {
  current: () => ({ requestId: 'ambient', organizationId: null, userId: null }),
  run: (_context, fn) => fn(),
  identify: () => undefined,
};

interface FakeTx {
  readonly $executeRaw: () => Promise<number>;
  readonly auditLog: { readonly create: (args: unknown) => Promise<unknown> };
}

/** A transaction whose statements all resolve at once: what remains is the process's own work. */
const fakeClient = (): { client: PrismaClient; tx: FakeTx } => {
  const tx: FakeTx = {
    $executeRaw: () => Promise.resolve(0),
    auditLog: { create: () => Promise.resolve({}) },
  };

  return {
    tx,
    client: {
      $transaction: (fn: (client: FakeTx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaClient,
  };
};

interface Payloads {
  readonly before: Readonly<Record<string, unknown>> | undefined;
  readonly after: Readonly<Record<string, unknown>>;
}

/** A handful of changed fields: the shape of most entries. */
const TYPICAL: Payloads = {
  before: undefined,
  after: { status: 'SUSPENDED', roleKey: 'member', teamId: ACTOR, displayName: 'A. Person' },
};

/** A role edit naming every key of the catalogue on both sides: the outlier the trail has to carry. */
const ROLE_EDIT: Payloads = {
  before: { key: 'support', name: 'Support', permissions: [...SharedPermissions.PERMISSIONS] },
  after: {
    key: 'support',
    name: 'Support, tier 2',
    permissions: [...SharedPermissions.PERMISSIONS],
  },
};

const eventFor = (action: AuditEvent['action'], payloads: Payloads): AuditEvent => ({
  action,
  actor: { userId: ACTOR, organizationId: ORG, ipAddress: '203.0.113.9' },
  target: { type: 'ROLE', id: ACTOR },
  ...(payloads.before === undefined ? {} : { before: payloads.before }),
  after: payloads.after,
  requestId: undefined,
});

/** What the control arm hands the fake insert: the row as the adapter would have built it, prebuilt. */
const rowFor = (event: AuditEvent): unknown => ({
  data: {
    organizationId: ORG,
    actorId: ACTOR,
    actorType: 'USER',
    action: event.action,
    resourceType: 'ROLE',
    resourceId: ACTOR,
    before: event.before,
    after: event.after,
    ipHash: 'prehashed',
    userAgent: null,
    requestId: 'ambient',
    severity: 'INFO',
  },
});

const percentile = (samples: readonly number[], fraction: number): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));

  return sorted[index] as number;
};

const mean = (samples: readonly number[]): number =>
  samples.reduce((total, value) => total + value, 0) / samples.length;

interface Arm {
  readonly control: number[];
  readonly audited: number[];
}

interface ArmSummary {
  readonly controlMeanUs: number;
  readonly auditedMeanUs: number;
  readonly auditedP50Us: number;
  readonly auditedP95Us: number;
  readonly deltaMeanUs: number;
  readonly deltaP50Us: number;
}

const toMicros = (started: bigint): number => Number(process.hrtime.bigint() - started) / 1e3;

const summarise = (arm: Arm): ArmSummary => ({
  controlMeanUs: Number(mean(arm.control).toFixed(2)),
  auditedMeanUs: Number(mean(arm.audited).toFixed(2)),
  auditedP50Us: Number(percentile(arm.audited, 0.5).toFixed(2)),
  auditedP95Us: Number(percentile(arm.audited, 0.95).toFixed(2)),
  deltaMeanUs: Number((mean(arm.audited) - mean(arm.control)).toFixed(2)),
  deltaP50Us: Number((percentile(arm.audited, 0.5) - percentile(arm.control, 0.5)).toFixed(2)),
});

const measure = async (action: AuditEvent['action'], payloads: Payloads): Promise<ArmSummary> => {
  const { client, tx } = fakeClient();
  const audit = degradingAuditLogger(
    countedAuditLogger(
      new PrismaAuditLogger({
        // The real hasher with a throwaway key: the digest is part of the port's work.
        addressHasher: new HmacAddressHasher(randomBytes(32).toString('base64')),
        requestContext,
        unscoped: { record: () => Promise.resolve() },
      }),
      createPromMetrics(),
    ),
    silent,
  );
  const event = eventFor(action, payloads);
  const row = rowFor(event);
  const control: number[] = [];
  const audited: number[] = [];

  const runControl = async (): Promise<number> => {
    const started = process.hrtime.bigint();

    await tx.auditLog.create(row);

    return toMicros(started);
  };

  const runAudited = async (): Promise<number> => {
    const started = process.hrtime.bigint();

    await audit.record(event);

    return toMicros(started);
  };

  await withTenant(client, { organizationId: ORG, userId: null }, async () => {
    for (let iteration = 0; iteration < ITERATIONS + WARMUP; iteration += 1) {
      const first = iteration % 2 === 0;
      const controlUs = first ? await runControl() : 0;
      const auditedUs = await runAudited();
      const trailingControlUs = first ? 0 : await runControl();

      if (iteration >= WARMUP) {
        control.push(first ? controlUs : trailingControlUs);
        audited.push(auditedUs);
      }
    }
  });

  return summarise({ control, audited });
};

describe('cost of the audit port, with the database taken out', () => {
  it('is a negligible share of the insert it precedes and of the request budget', async () => {
    // Recorded 2026-09-06 (Node 22.22, Apple M-series, `vitest run --coverage.enabled=false`, three
    // runs). Typical payload, degradable action through the savepoint branch: control 0.5 µs,
    // audited 9.8–11.1 µs, **delta 9.3–10.6 µs** (p50 7.5–8.3, p95 15–17). Role edit naming all 331
    // catalogue keys on both sides, WARNING action: control 0.4 µs, audited 48.5–55.4 µs, **delta
    // 48–55 µs** (p50 47–56, p95 68–77) — that is the redaction walk over 662 strings against five
    // value shapes each, and it is 0.04 % of the request budget and about a fortieth of the 2.01 ms
    // the same row costs to insert. The table and what moves it: `docs/runbooks/audit-log.md`,
    // «Стоимость порта».
    const typical = await measure('employee.updated', TYPICAL);
    const roleEdit = await measure('role.updated', ROLE_EDIT);

    // Ceilings, not the numbers: this runs on whatever CI was given, and what has to survive that
    // is «the port is not what makes a privileged action slow». Both ceilings sit an order of
    // magnitude above the recorded p50 and still under 1 % of the budget; the median, so one pause
    // in two thousand iterations cannot fail the gate (docstring above).
    expect(typical.deltaP50Us).toBeLessThan(200);
    expect(roleEdit.deltaP50Us).toBeLessThan(1_000);
    expect(roleEdit.deltaMeanUs / 1_000).toBeLessThan(REQUEST_BUDGET_MS * 0.01);
  }, 60_000);
});
