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

describe('an event that cannot be a row', () => {
  it('goes to the log when there is no tenant scope at all', async () => {
    const create = vi.fn();
    const unscoped = vi.fn<RecordFn>().mockResolvedValue(undefined);
    const logger = loggerFor(unscoped);

    await logger.record(event());

    expect(create).not.toHaveBeenCalled();
    expect(unscoped).toHaveBeenCalledTimes(1);
  });

  it('goes to the log when the event belongs to no organization', async () => {
    const create = vi.fn();
    const unscoped = vi.fn<RecordFn>().mockResolvedValue(undefined);
    const logger = loggerFor(unscoped);

    await withTenant(fakeClient(create), { organizationId: ORG, userId: null }, async () => {
      await logger.record(
        event({ actor: { userId: undefined, organizationId: undefined, ipAddress: undefined } }),
      );
    });

    expect(create).not.toHaveBeenCalled();
    expect(unscoped).toHaveBeenCalledTimes(1);
  });

  /**
   * The branch that matters most, and the one a reasonable implementation gets wrong: filing the row
   * under the open scope. An event of organization B in organization A's trail is worse than a
   * missing one — a reader of A cannot tell it does not belong to them.
   */
  it('refuses an event whose organization disagrees with the open scope', async () => {
    const create = vi.fn();
    const unscoped = vi.fn<RecordFn>().mockResolvedValue(undefined);
    const logger = loggerFor(unscoped);

    await withTenant(fakeClient(create), { organizationId: ORG, userId: null }, async () => {
      await logger.record(
        event({
          actor: {
            userId: undefined,
            organizationId: '00000000-0000-4000-8000-000000000c02',
            ipAddress: undefined,
          },
        }),
      );
    });

    expect(create).not.toHaveBeenCalled();
    expect(unscoped).toHaveBeenCalledTimes(1);
  });
});
