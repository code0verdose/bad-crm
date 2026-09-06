import { type PrismaClient } from '@prisma/client';
import { assert, describe, expect, it } from 'vitest';

import { type AuditEvent } from '@/application/platform/ports/audit-logger.port.js';
import { buildContainer } from '@/infrastructure/bootstrap/container.factory.js';
import { AUDIT_WRITE_DEGRADED_EVENT } from '@/infrastructure/logging/degrading-audit-logger.adapter.js';
import { createRootLogger } from '@/infrastructure/logging/pino-logger.adapter.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

import { testEnv } from '../../support/test-app.util.js';

/**
 * The audit chain as the process actually wires it — STORY-016-02, acceptance 9, through
 * `container.audit` rather than through a chain a test built itself.
 *
 * ## Why here and not beside the decorators
 *
 * `audit-write-degradation.test.ts` and `audit-port-cost.test.ts`
 * both assemble `degradingAuditLogger(countedAuditLogger(new PrismaAuditLogger(…)))` by hand, so
 * what each proves is the order *it* chose. The docstring in `container.factory.ts` calls the order
 * a contract, and the contract had no observation point: swapping the two decorators there — the
 * counter outside, the degrading decision inside — left every suite green while
 * `audit_write_failed_total` stopped seeing the one class of failure it exists for, the degraded
 * `INFO` write that never reaches the caller. The same class of defect as the argon2 ceiling in
 * `identity-wiring.test.ts`, closed the same way: the container publishes the instance the
 * use-cases got, and the assertion runs against that.
 *
 * ## Why a fake transaction is enough
 *
 * The adapter reads its transaction out of `withTenant`'s AsyncLocalStorage, and needs three
 * things from it: `$executeRaw` for the tenant `set_config` calls and the savepoint fence, and an
 * `auditLog.create` that can fail. What is under test is who finds out about the failure — the
 * counter, the log, the caller — and that is decided entirely in the process. The transaction
 * semantics the fence buys are proved against PostgreSQL in `audit-write-degradation.test.ts`.
 */

const ORG = '00000000-0000-4000-8000-000000000e01';

interface Line {
  readonly event?: string;
  readonly action?: string;
  readonly level: number;
}

const capturing = (): { lines: Line[]; write: (line: string) => void } => {
  const lines: Line[] = [];

  return { lines, write: (line) => lines.push(JSON.parse(line) as Line) };
};

/** A client whose transaction's insert always fails the way a database failure does: after the statement was issued. */
const failingClient = (cause: Error): PrismaClient => {
  const tx = {
    $executeRaw: () => Promise.resolve(0),
    auditLog: { create: () => Promise.reject(cause) },
  };

  return {
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
};

const event = (action: AuditEvent['action'], type: AuditEvent['target']['type']): AuditEvent => ({
  action,
  actor: { userId: undefined, organizationId: ORG, ipAddress: undefined },
  target: { type, id: undefined },
  requestId: 'wiring',
});

const failedWrites = async (render: () => Promise<string>): Promise<number> => {
  const line = (await render())
    .split('\n')
    .find((row) => row.startsWith('audit_write_failed_total '));

  return Number(line?.split(' ')[1] ?? Number.NaN);
};

describe('the audit chain the process actually hands out', () => {
  it('counts a degraded INFO write, reports it, and lets the caller go on', async () => {
    const destination = capturing();
    const container = buildContainer({
      env: testEnv({ METRICS_ENABLED: true, METRICS_TOKEN: 'm'.repeat(32) }),
      logger: createRootLogger({ level: 'error', version: '0.0.0' }, destination),
    });
    const metrics = container.http.metrics;

    assert(metrics !== undefined, 'metrics were enabled, so the port must be mounted');

    await expect(
      withTenant(failingClient(new Error('disk full')), { organizationId: ORG, userId: null }, () =>
        container.audit.record(event('session.signed_in', 'SESSION')),
      ),
    ).resolves.toBeUndefined();

    // The counter is inside the degrading decision: a failure the caller never hears about is
    // still a failure it counted. This is the assertion that turns red when the two are swapped.
    expect(await failedWrites(() => metrics.port.render())).toBe(1);
    expect(destination.lines.filter((line) => line.event === AUDIT_WRITE_DEGRADED_EVENT)).toEqual([
      expect.objectContaining({ action: 'session.signed_in' }),
    ]);
  });

  /**
   * CONTROL: the other outcome through the same instance — a loud action is refused, and counted
   * on its way out. Without this the case above would also pass for a chain that swallows
   * everything and counts everything.
   */
  it('CONTROL: refuses a WARNING write, and counts it on the way out', async () => {
    const destination = capturing();
    const container = buildContainer({
      env: testEnv({ METRICS_ENABLED: true, METRICS_TOKEN: 'm'.repeat(32) }),
      logger: createRootLogger({ level: 'error', version: '0.0.0' }, destination),
    });
    const metrics = container.http.metrics;
    const cause = new Error('disk full');

    assert(metrics !== undefined, 'metrics were enabled, so the port must be mounted');

    await expect(
      withTenant(failingClient(cause), { organizationId: ORG, userId: null }, () =>
        container.audit.record(event('password.changed', 'USER')),
      ),
    ).rejects.toBe(cause);

    expect(await failedWrites(() => metrics.port.render())).toBe(1);
    expect(destination.lines.filter((line) => line.event === AUDIT_WRITE_DEGRADED_EVENT)).toEqual(
      [],
    );
  });
});
