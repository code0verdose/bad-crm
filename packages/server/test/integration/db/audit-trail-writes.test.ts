import { randomUUID } from 'node:crypto';

import { type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import { PrismaAuditLogger } from '@/infrastructure/persistence/prisma/audit-log.adapter.js';
import { createPrismaClient } from '@/infrastructure/persistence/prisma/prisma.client.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * The trail is written **inside the transaction that caused it** — proved by rolling one back.
 *
 * §10 of the permission model asks for exactly this and gives both halves of the reason: an entry
 * written outside the transaction survives a rollback and records an event that never happened,
 * while one written after the commit is lost if the process dies in between. Neither failure is
 * visible from the outside, and both are answered by the same property — so the property is tested
 * rather than asserted in a comment.
 */

const silent: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: (): LoggerPort => silent,
};

const ORG = '00000000-0000-4000-8000-0000000000b1';

let prisma: PrismaClient;
let migrator: PrismaClient;
/** What the log sink received: the events that could not be rows. */
let unscopedEvents: string[];
let audit: AuditLoggerPort;

const requestContext: RequestContextPort = {
  current: () => ({ requestId: 'ambient-request-id', organizationId: null, userId: null }),
  run: (_context, fn) => fn(),
  identify: () => undefined,
};

beforeAll(async () => {
  const urls = inject('databaseUrls');

  prisma = createPrismaClient({ url: urls.appUser, logger: silent });
  migrator = createPrismaClient({ url: urls.migrator, logger: silent });

  unscopedEvents = [];
  audit = new PrismaAuditLogger({
    // A stand-in for the keyed hash: what matters here is that the column never receives the
    // address itself, which an identity function would hide.
    addressHasher: { hash: (address) => `hashed:${address ?? 'none'}` },
    requestContext,
    unscoped: {
      record: (event) => {
        unscopedEvents.push(event.action);

        return Promise.resolve();
      },
    },
  });

  const ownerId = randomUUID();

  await migrator.$executeRawUnsafe(`SET app.maintenance = 'on'`);
  await migrator.$executeRawUnsafe(
    `WITH created_organization AS (
       INSERT INTO organizations (id, owner_id, slug, name, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'Audit writes', now())
       ON CONFLICT (id) DO NOTHING
       RETURNING id
     )
     INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
     SELECT $2::uuid, $1::uuid, $4, 'placeholder-not-a-credential', 'ACTIVE', now()
     FROM created_organization`,
    ORG,
    ownerId,
    `writes-${randomUUID().slice(0, 8)}`,
    `owner-${ownerId}@example.test`,
  );
});

afterAll(async () => {
  await Promise.all([prisma.$disconnect(), migrator.$disconnect()]);
});

const entriesOf = async (action: string): Promise<Record<string, unknown>[]> => {
  await migrator.$executeRawUnsafe(`SET app.maintenance = 'on'`);

  return migrator.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM audit_logs WHERE organization_id = $1::uuid AND action = $2`,
    ORG,
    action,
  );
};

describe('an audit entry and the change that caused it', () => {
  it('is written as a row, with the severity of its action and a hashed address', async () => {
    await withTenant(prisma, { organizationId: ORG, userId: null }, async () => {
      await audit.record({
        action: 'password.changed',
        actor: { userId: undefined, organizationId: ORG, ipAddress: '203.0.113.7' },
        target: { type: 'user', id: undefined },
        after: { revokedFamilies: 2 },
        requestId: undefined,
      });
    });

    const [entry] = await entriesOf('password.changed');

    expect(entry).toMatchObject({
      organization_id: ORG,
      action: 'password.changed',
      resource_type: 'user',
      // From `AUDIT_ACTION_SEVERITY`, not from the call site: the same action filed at two levels
      // makes a filter over the trail silently incomplete.
      severity: 'WARNING',
      after: { revokedFamilies: 2 },
      // Taken from the ambient request context, because the use-case had none to pass.
      request_id: 'ambient-request-id',
    });
    // The address is never the value in the column.
    expect(entry?.['ip_hash']).toBe('hashed:203.0.113.7');
  });

  it('disappears when the transaction that caused it rolls back', async () => {
    const failing = withTenant(prisma, { organizationId: ORG, userId: null }, async () => {
      await audit.record({
        action: 'session.revoked',
        actor: { userId: undefined, organizationId: ORG, ipAddress: undefined },
        target: { type: 'session', id: undefined },
        requestId: 'doomed-request',
      });

      throw new Error('the change failed after the trail was written');
    });

    await expect(failing).rejects.toThrow('the change failed after the trail was written');

    // CONTROL for the assertion below: the same write *does* leave a row when the transaction
    // commits, so an empty result here means the rollback took it and not that the write never
    // worked.
    await withTenant(prisma, { organizationId: ORG, userId: null }, async () => {
      await audit.record({
        action: 'session.revoked',
        actor: { userId: undefined, organizationId: ORG, ipAddress: undefined },
        target: { type: 'session', id: undefined },
        requestId: 'surviving-request',
      });
    });

    const entries = await entriesOf('session.revoked');

    expect(entries.map((entry) => entry['request_id'])).toEqual(['surviving-request']);
  });

  it('sends an event with no organization to the log instead of failing the caller', async () => {
    // A refused sign-in has no tenant yet, and `organization_id` is NOT NULL. Answering with an
    // error would make the trail able to fail the operation it is describing.
    await audit.record({
      action: 'session.signed_in',
      actor: { userId: undefined, organizationId: undefined, ipAddress: undefined },
      target: { type: 'user', id: undefined },
      requestId: 'no-tenant',
    });

    expect(unscopedEvents).toContain('session.signed_in');
    expect(await entriesOf('session.signed_in')).toEqual([]);
  });

  it('does not write an entry of one organization into the scope of another', async () => {
    // The scope is the authority on the tenant, and a mismatch is a bug in the caller. Filing the
    // row under the scope would put an event of organization B into organization A's trail — worse
    // than not recording it, because a reader of A cannot tell.
    await withTenant(prisma, { organizationId: ORG, userId: null }, async () => {
      await audit.record({
        action: 'rls.bypassed',
        actor: {
          userId: undefined,
          organizationId: '00000000-0000-4000-8000-0000000000b2',
          ipAddress: undefined,
        },
        target: { type: 'organization', id: undefined },
        requestId: 'mismatched',
      });
    });

    expect(unscopedEvents).toContain('rls.bypassed');
    expect(await entriesOf('rls.bypassed')).toEqual([]);
  });
});
