import { type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { type AuditEvent } from '@/application/platform/ports/audit-logger.port.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import { PrismaAuditLogger } from '@/infrastructure/persistence/prisma/audit-log.adapter.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * Which events become rows, and what the row says — decided without a database.
 *
 * The transaction semantics are proved against a real PostgreSQL
 * (`test/integration/db/audit-trail-writes.test.ts`, by rolling one back); what is checked here is
 * the branching, which is where the failures are silent: an event filed under the wrong tenant, an
 * address stored instead of its digest, a severity taken from the caller. A fake transaction is
 * enough for all three, and it is the only way to see the values the adapter actually passes.
 */

const ORG = '00000000-0000-4000-8000-000000000c01';

const requestContext: RequestContextPort = {
  current: () => ({ requestId: 'ambient', organizationId: null, userId: null }),
  run: (_context, fn) => fn(),
  identify: () => undefined,
};

/**
 * A client whose `$transaction` runs the callback against a stub. `withTenant` needs exactly two
 * things from it — a transaction and `$executeRaw` for the two `set_config` calls — so the double
 * is small enough to read and real enough to put the adapter inside a tenant scope.
 */
const fakeClient = (create: ReturnType<typeof vi.fn>): PrismaClient => {
  const tx = {
    $executeRaw: () => Promise.resolve(0),
    auditLog: { create },
  };

  return {
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
};

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  action: 'password.changed',
  actor: { userId: 'user-1', organizationId: ORG, ipAddress: '203.0.113.9' },
  target: { type: 'USER', id: 'user-1' },
  requestId: undefined,
  ...overrides,
});

type RecordFn = (event: AuditEvent) => Promise<void>;

const loggerFor = (unscoped: RecordFn): PrismaAuditLogger =>
  new PrismaAuditLogger({
    addressHasher: { hash: (address) => `digest:${address ?? 'none'}` },
    requestContext,
    unscoped: { record: unscoped },
  });

describe('an event that can be a row', () => {
  it('writes it with the severity of the action, a hashed address and the ambient request id', async () => {
    const create = vi.fn().mockResolvedValue({});
    const unscoped = vi.fn<RecordFn>().mockResolvedValue(undefined);
    const logger = loggerFor(unscoped);

    await withTenant(fakeClient(create), { organizationId: ORG, userId: null }, async () => {
      await logger.record(event({ after: { revokedFamilies: 1 } }));
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: ORG,
        actorId: 'user-1',
        actorType: 'USER',
        action: 'password.changed',
        resourceType: 'USER',
        resourceId: 'user-1',
        after: { revokedFamilies: 1 },
        ipHash: 'digest:203.0.113.9',
        requestId: 'ambient',
        severity: 'WARNING',
      }),
    });
    expect(unscoped).not.toHaveBeenCalled();
  });

  it('calls an event with no acting person a SYSTEM one', async () => {
    const create = vi.fn().mockResolvedValue({});
    const logger = loggerFor(() => Promise.resolve());

    await withTenant(fakeClient(create), { organizationId: ORG, userId: null }, async () => {
      await logger.record(
        event({ actor: { userId: undefined, organizationId: ORG, ipAddress: undefined } }),
      );
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      data: { actorType: 'SYSTEM', actorId: null, ipHash: null },
    });
  });

  it('prefers the request id the caller passed over the ambient one', async () => {
    const create = vi.fn().mockResolvedValue({});
    const logger = loggerFor(() => Promise.resolve());

    await withTenant(fakeClient(create), { organizationId: ORG, userId: null }, async () => {
      await logger.record(event({ requestId: 'explicit' }));
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({ data: { requestId: 'explicit' } });
  });
});

/**
 * The guard in front of the trail, at the one place both channels pass through.
 *
 * It lives here rather than in each use-case for the reason the port's own comment gives: a rule
 * every caller has to remember is a rule that holds until one of them does not. The unscoped branch
 * matters as much as the row: an event of an organization that is not yet known goes to the log, and
 * a log line is read by everyone with access to the logs.
 */
describe('a payload carrying something it should not', () => {
  it('cuts it out of the row and records that it was cut', async () => {
    const create = vi.fn().mockResolvedValue({});
    const logger = loggerFor(() => Promise.resolve());

    await withTenant(fakeClient(create), { organizationId: ORG, userId: null }, async () => {
      await logger.record(event({ after: { roleId: 'role-1', apiKey: 'sk-live-1' } }));
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      data: { after: { roleId: 'role-1', apiKey: '[redacted]', _redacted: ['apiKey'] } },
    });
  });

  it('cuts it out of the event that goes to the log instead', async () => {
    const unscoped = vi.fn<RecordFn>().mockResolvedValue(undefined);
    const logger = loggerFor(unscoped);

    // One of the actions that may be recorded without an organization, because those are the only
    // ones the log sink still receives (`unscoped-audit-actions.constant.ts`).
    await logger.record(
      event({
        action: 'rls.bypassed',
        actor: { userId: undefined, organizationId: undefined, ipAddress: undefined },
        before: { password: 'hunter2' },
      }),
    );

    expect(unscoped.mock.calls[0]?.[0].before).toStrictEqual({
      password: '[redacted]',
      _redacted: ['password'],
    });
  });
});

/**
 * Which events may leave the table at all — and which are refused instead of quietly logged — lives
 * in `audit-unscoped-guard.test.ts`, beside the list that decides it. It is one behaviour, so it has
 * one home; splitting it across two files is how the second copy drifts.
 */
