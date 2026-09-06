import { randomUUID } from 'node:crypto';

import { type PrismaClient } from '@prisma/client';
import { afterAll, assert, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type LogFields, type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import { degradingAuditLogger } from '@/infrastructure/logging/degrading-audit-logger.adapter.js';
import { countedAuditLogger } from '@/infrastructure/metrics/counted-audit-logger.adapter.js';
import { createPromMetrics } from '@/infrastructure/metrics/prom-client.adapter.js';
import { PrismaAuditLogger } from '@/infrastructure/persistence/prisma/audit-log.adapter.js';
import { createPrismaClient } from '@/infrastructure/persistence/prisma/prisma.client.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * What happens to the action when its audit row cannot be written — STORY-016-02, acceptance 9,
 * proved against a real PostgreSQL because a fake transaction cannot show the thing at stake.
 *
 * The thing at stake is `25P02`. A statement that fails inside a transaction leaves it aborted, and
 * everything after it is refused — the caller's next query, and the `COMMIT`. So a decorator that
 * swallows the failure of an INFO row does not, on its own, let the action through: it lets the
 * use-case run on into a transaction that will contradict it at commit. The adapter fences the INFO
 * insert in a savepoint and rolls back to it on failure; the decorator above it swallows and
 * reports. Each half is unit-tested alone; this file is where the pair is shown to hold together,
 * and where the reason for the savepoint is demonstrated rather than asserted.
 *
 * ## How the failure is induced, and why not otherwise
 *
 * A payload string carrying `\u0000`: `jsonb` refuses it (`22P05`, «unsupported Unicode escape
 * sequence»), and it refuses it **in the database**, inside the transaction, after the statement
 * was sent. It is also a failure an installation can meet — a NUL that survived from user input
 * into a name that ends up in `after`. The first draft used `resourceId: 'not-a-uuid'` and proved
 * nothing: Prisma's engine rejects a malformed uuid before the statement leaves the process, so the
 * transaction was never aborted and the unfenced control below passed for the wrong reason.
 *
 * ## The marker of «the action itself»
 *
 * `users.email_verified_at`, written in the same transaction as the row. Not `updated_at`: a
 * `BEFORE UPDATE` trigger overwrites that with `now()`, so a stamp written there reads back as the
 * time of the write rather than the value, and «did the change commit» becomes unanswerable.
 */

const ORG = '00000000-0000-4000-8000-0000000000d3';
const OWNER = '00000000-0000-4000-8000-0000000000d4';

/** A value PostgreSQL will not store in `jsonb` — the row fails inside the database, not before. */
const UNSTORABLE = 'lap\u0000top';

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

interface Line {
  readonly fields: LogFields;
  readonly message: string;
}

let prisma: PrismaClient;
let migrator: PrismaClient;
let metrics: ReturnType<typeof createPromMetrics>;
let errorLines: Line[];
let audit: AuditLoggerPort;

/**
 * A maintenance read on one connection. `SET` followed by a query on a pooled client can land on
 * two different connections, and the second one — without `app.maintenance` — sees no rows at all
 * under the migrator's policy; a transaction pins both statements to the same connection.
 */
const asMaintenance = <T>(
  query: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> =>
  migrator.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.maintenance = 'on'`);

    return query(tx);
  });

const failedWrites = async (): Promise<number> => {
  const line = (await metrics.render())
    .split('\n')
    .find((candidate) => candidate.startsWith('audit_write_failed_total '));

  return Number(line?.split(' ')[1] ?? Number.NaN);
};

const entriesOf = (requestId: string): Promise<Record<string, unknown>[]> =>
  asMaintenance((tx) =>
    tx.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT action, resource_id FROM audit_logs WHERE organization_id = $1::uuid AND request_id = $2`,
      ORG,
      requestId,
    ),
  );

/** The ordinary write of the action being audited: what has to commit or roll back with the row. */
const ownerVerifiedAt = async (): Promise<string | null> => {
  const [row] = await asMaintenance((tx) =>
    tx.$queryRawUnsafe<{ email_verified_at: Date | null }[]>(
      `SELECT email_verified_at FROM users WHERE id = $1::uuid`,
      OWNER,
    ),
  );

  return (row as { email_verified_at: Date | null }).email_verified_at?.toISOString() ?? null;
};

const stamp = (label: string): string => `2030-01-01T00:00:${label}.000Z`;

beforeAll(async () => {
  const urls = inject('databaseUrls');

  prisma = createPrismaClient({ url: urls.appUser, logger: silent });
  migrator = createPrismaClient({ url: urls.migrator, logger: silent });

  await asMaintenance((tx) =>
    tx.$executeRawUnsafe(
      `WITH created_organization AS (
         INSERT INTO organizations (id, owner_id, slug, name, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Audit degradation', now())
         ON CONFLICT (id) DO NOTHING
         RETURNING id
       )
       INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
       SELECT $2::uuid, $1::uuid, $4, 'placeholder-not-a-credential', 'ACTIVE', now()
       FROM created_organization`,
      ORG,
      OWNER,
      `degradation-${randomUUID().slice(0, 8)}`,
      `owner-${OWNER}@example.test`,
    ),
  );
});

beforeEach(() => {
  metrics = createPromMetrics();
  errorLines = [];

  const logger: LoggerPort = {
    ...silent,
    error: (fields, message) => errorLines.push({ fields, message }),
  };

  // The chain exactly as the composition root builds it: the counter sees every failure, the
  // decorator decides who else does.
  audit = degradingAuditLogger(
    countedAuditLogger(
      new PrismaAuditLogger({
        addressHasher: { hash: (address) => `hashed:${address ?? 'none'}` },
        requestContext,
        unscoped: { record: () => Promise.resolve() },
      }),
      metrics,
    ),
    logger,
  );
});

afterAll(async () => {
  await Promise.all([prisma.$disconnect(), migrator.$disconnect()]);
});

describe('an INFO row that cannot be written', () => {
  it('lets the action commit, leaves the transaction usable, and is counted and reported', async () => {
    await withTenant(prisma, { organizationId: ORG, userId: null }, async (tx) => {
      await tx.$executeRaw`UPDATE users SET email_verified_at = ${stamp('01')}::timestamptz WHERE id = ${OWNER}::uuid`;

      await audit.record({
        action: 'session.signed_in',
        actor: { userId: undefined, organizationId: ORG, ipAddress: undefined },
        target: { type: 'SESSION', id: undefined },
        after: { deviceLabel: UNSTORABLE },
        requestId: 'degraded',
      });

      // The transaction is still alive after the failed insert — the property the savepoint buys.
      // A second, well-formed row in the same transaction is the proof, and a `25P02` here the
      // failure.
      await audit.record({
        action: 'session.signed_in',
        actor: { userId: undefined, organizationId: ORG, ipAddress: undefined },
        target: { type: 'SESSION', id: undefined },
        requestId: 'after-degradation',
      });
    });

    expect(await ownerVerifiedAt()).toBe(stamp('01'));
    expect(await entriesOf('degraded')).toEqual([]);
    expect(await entriesOf('after-degradation')).toEqual([
      { action: 'session.signed_in', resource_id: null },
    ]);
    expect(await failedWrites()).toBe(1);
    expect(errorLines).toHaveLength(1);
    const [errorLine] = errorLines;

    assert(errorLine !== undefined, 'the degraded write must have produced one error line');
    expect(errorLine.fields).toMatchObject({
      action: 'session.signed_in',
      severity: 'INFO',
      requestId: 'degraded',
    });
    expect(JSON.stringify(errorLine.fields)).not.toContain('laptop');
  });

  /**
   * CONTROL: the same INFO action with a storable row is written, counted nowhere and reported
   * nowhere. Without this the suite is satisfied by a chain that never writes INFO rows at all.
   */
  it('CONTROL: is written when it can be, with nothing counted and nothing reported', async () => {
    await withTenant(prisma, { organizationId: ORG, userId: null }, async () => {
      await audit.record({
        action: 'session.signed_in',
        actor: { userId: undefined, organizationId: ORG, ipAddress: undefined },
        target: { type: 'SESSION', id: undefined },
        after: { deviceLabel: 'laptop' },
        requestId: 'info-control',
      });
    });

    expect(await entriesOf('info-control')).toHaveLength(1);
    expect(await failedWrites()).toBe(0);
    expect(errorLines).toEqual([]);
  });
});

describe('a WARNING or CRITICAL row that cannot be written', () => {
  it.each([
    ['WARNING', 'password.changed', 'USER'],
    ['CRITICAL', 'organization.ownership_transferred', 'ORGANIZATION'],
  ] as const)('rolls the action back with it (%s)', async (label, action, type) => {
    const before = await ownerVerifiedAt();

    const failing = withTenant(prisma, { organizationId: ORG, userId: null }, async (tx) => {
      await tx.$executeRaw`UPDATE users SET email_verified_at = ${stamp('02')}::timestamptz WHERE id = ${OWNER}::uuid`;

      await audit.record({
        action,
        actor: { userId: undefined, organizationId: ORG, ipAddress: undefined },
        target: { type, id: undefined },
        after: { deviceLabel: UNSTORABLE },
        requestId: `refused-${label}`,
      });
    });

    await expect(failing).rejects.toThrow();

    expect(await ownerVerifiedAt()).toBe(before);
    expect(await entriesOf(`refused-${label}`)).toEqual([]);
    expect(await failedWrites()).toBe(1);
    // The rejection is the report: it reaches the error handler with the request that failed, and
    // a second line from the trail would be the same failure logged twice.
    expect(errorLines).toEqual([]);
  });

  /** CONTROL: the same WARNING action with a storable row commits together with the change. */
  it('CONTROL: commits together with the change when the row can be written', async () => {
    await withTenant(prisma, { organizationId: ORG, userId: null }, async (tx) => {
      await tx.$executeRaw`UPDATE users SET email_verified_at = ${stamp('03')}::timestamptz WHERE id = ${OWNER}::uuid`;

      await audit.record({
        action: 'password.changed',
        actor: { userId: undefined, organizationId: ORG, ipAddress: undefined },
        target: { type: 'USER', id: undefined },
        after: { deviceLabel: 'laptop' },
        requestId: 'warning-control',
      });
    });

    expect(await ownerVerifiedAt()).toBe(stamp('03'));
    expect(await entriesOf('warning-control')).toHaveLength(1);
    expect(await failedWrites()).toBe(0);
  });
});

/**
 * Two records started together on one transaction, the second of which fails.
 *
 * `Promise.all` over two `record` calls is legal and nobody writes it today (zero of the call sites
 * in the tree), which is precisely why it is proved rather than documented. A savepoint is a point
 * on the connection's stack and `ROLLBACK TO` undoes everything after it; with one shared name and
 * two records racing, both savepoints were on the stack before either insert ran, and the rollback
 * of the second erased the first's row — a success reported, a row missing, a counter that saw one
 * failure where the trail has two holes. The adapter serialises records per transaction and names
 * each fence on its own; this is the row surviving on a real database.
 */
describe('two INFO records racing in one transaction, the second of which fails', () => {
  it('keeps the first row, drops only the second, and counts exactly one failure', async () => {
    await withTenant(prisma, { organizationId: ORG, userId: null }, async () => {
      await Promise.all([
        audit.record({
          action: 'session.signed_in',
          actor: { userId: undefined, organizationId: ORG, ipAddress: undefined },
          target: { type: 'SESSION', id: undefined },
          after: { deviceLabel: 'laptop' },
          requestId: 'race-first',
        }),
        audit.record({
          action: 'session.signed_in',
          actor: { userId: undefined, organizationId: ORG, ipAddress: undefined },
          target: { type: 'SESSION', id: undefined },
          after: { deviceLabel: UNSTORABLE },
          requestId: 'race-second',
        }),
      ]);
    });

    expect(await entriesOf('race-first')).toEqual([
      { action: 'session.signed_in', resource_id: null },
    ]);
    expect(await entriesOf('race-second')).toEqual([]);
    expect(await failedWrites()).toBe(1);
    expect(errorLines.map((line) => line.fields['requestId'])).toEqual(['race-second']);
  });
});

/**
 * Why the adapter pays two round trips for an INFO row: the aborted transaction, shown rather than
 * cited. The insert is issued **without** the adapter, the failure is swallowed the way a decorator
 * alone would swallow it, and the next statement is refused by PostgreSQL. This is the failure the
 * savepoint exists to prevent, and the reason «swallow the error» is not an implementation of
 * acceptance 9 on its own.
 */
describe('CONTROL: a failed insert with no savepoint around it', () => {
  it('leaves the transaction aborted, so the action could not commit either', async () => {
    const outcome = withTenant(prisma, { organizationId: ORG, userId: null }, async (tx) => {
      await tx.auditLog
        .create({
          data: {
            organizationId: ORG,
            actorId: null,
            actorType: 'SYSTEM',
            action: 'session.signed_in',
            resourceType: 'SESSION',
            resourceId: null,
            after: { deviceLabel: UNSTORABLE },
            requestId: 'unfenced',
            severity: 'INFO',
          },
        })
        .catch(() => undefined);

      return tx.$queryRaw`SELECT 1 AS alive`;
    });

    await expect(outcome).rejects.toThrow(/current transaction is aborted/);
  });
});
