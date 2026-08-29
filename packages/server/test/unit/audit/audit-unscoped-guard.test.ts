import { type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AUDIT_ACTIONS_WITHOUT_ORGANIZATION } from '@/application/platform/audit/unscoped-audit-actions.constant.js';

import { type AuditEvent } from '@/application/platform/ports/audit-logger.port.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import { PrismaAuditLogger } from '@/infrastructure/persistence/prisma/audit-log.adapter.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * What may leave the table, and what may not.
 *
 * The trail's promise is fail-closed: an action nobody could write down did not happen. A branch
 * that answers «could not be a row» with a log line keeps the promise only for the events that have
 * no row to be — and the condition deciding that used to be structural (no scope, no organization,
 * a scope that disagrees), so **any** privileged action whose caller drifted out of the ambient
 * scope became a rotated log line, with nothing in the return value saying so.
 *
 * The list is what replaces the condition. It is short on purpose: the trail is tenant-bound by
 * design, and the entries below are the ones whose organization does not exist as a question.
 */

const ORG = '00000000-0000-4000-8000-000000000c01';
const OTHER_ORG = '00000000-0000-4000-8000-000000000c02';

const requestContext: RequestContextPort = {
  current: () => ({ requestId: 'ambient', organizationId: null, userId: null }),
  run: (_context, fn) => fn(),
  identify: () => undefined,
};

const fakeClient = (create: ReturnType<typeof vi.fn>): PrismaClient => {
  const tx = {
    $executeRaw: () => Promise.resolve(0),
    auditLog: { create },
  };

  return {
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
};

type RecordFn = (event: AuditEvent) => Promise<void>;

const loggerFor = (unscoped: RecordFn): PrismaAuditLogger =>
  new PrismaAuditLogger({
    addressHasher: { hash: (address) => `digest:${address ?? 'none'}` },
    requestContext,
    unscoped: { record: unscoped },
  });

/** A tenant-bound action: a password is changed by somebody, inside some organization, always. */
const tenantBound = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  action: 'password.changed',
  actor: { userId: 'user-1', organizationId: ORG, ipAddress: undefined },
  target: { type: 'USER', id: 'user-1' },
  requestId: undefined,
  ...overrides,
});

describe('an action that has an organization by nature', () => {
  it('is refused rather than logged when no tenant scope is open', async () => {
    const create = vi.fn();
    const unscoped = vi.fn<RecordFn>().mockResolvedValue(undefined);
    const logger = loggerFor(unscoped);

    await expect(logger.record(tenantBound())).rejects.toThrow(/password\.changed/);
    expect(create).not.toHaveBeenCalled();
    expect(unscoped).not.toHaveBeenCalled();
  });

  it('is refused when the event names no organization at all', async () => {
    const create = vi.fn();
    const unscoped = vi.fn<RecordFn>().mockResolvedValue(undefined);
    const logger = loggerFor(unscoped);

    await withTenant(fakeClient(create), { organizationId: ORG, userId: null }, async () => {
      await expect(
        logger.record(
          tenantBound({
            actor: { userId: undefined, organizationId: undefined, ipAddress: undefined },
          }),
        ),
      ).rejects.toThrow(/password\.changed/);
    });

    expect(create).not.toHaveBeenCalled();
    expect(unscoped).not.toHaveBeenCalled();
  });

  /**
   * A mismatch is a caller bug for every action, the listed ones included: the scope is the
   * authority on the tenant, and an event naming another organization is either misrouted or
   * mislabelled. Neither may become a row, and neither may become a quiet log line.
   */
  it('is refused when the event disagrees with the open scope', async () => {
    const create = vi.fn();
    const unscoped = vi.fn<RecordFn>().mockResolvedValue(undefined);
    const logger = loggerFor(unscoped);

    await withTenant(fakeClient(create), { organizationId: ORG, userId: null }, async () => {
      await expect(
        logger.record(
          tenantBound({
            actor: { userId: undefined, organizationId: OTHER_ORG, ipAddress: undefined },
          }),
        ),
      ).rejects.toThrow(/password\.changed/);
    });

    expect(create).not.toHaveBeenCalled();
    expect(unscoped).not.toHaveBeenCalled();
  });

  it('refuses a listed action too, when it names an organization the scope disagrees with', async () => {
    const create = vi.fn();
    const unscoped = vi.fn<RecordFn>().mockResolvedValue(undefined);
    const logger = loggerFor(unscoped);

    await withTenant(fakeClient(create), { organizationId: ORG, userId: null }, async () => {
      await expect(
        logger.record(
          tenantBound({
            action: 'rls.bypassed',
            actor: { userId: undefined, organizationId: OTHER_ORG, ipAddress: undefined },
            target: { type: 'ORGANIZATION', id: undefined },
          }),
        ),
      ).rejects.toThrow(/rls\.bypassed/);
    });

    expect(unscoped).not.toHaveBeenCalled();
  });
});

/**
 * POSITIVE CONTROL for all four refusals above. Without it the suite is satisfied by an adapter that
 * refuses everything — which would take the trail's only sink for the events that genuinely have no
 * organization down with the hole it was meant to close.
 */
describe('an action listed as having no organization', () => {
  it('goes to the log when it names none and no scope is open', async () => {
    const unscoped = vi.fn<RecordFn>().mockResolvedValue(undefined);
    const logger = loggerFor(unscoped);

    await logger.record({
      action: 'rls.bypassed',
      actor: { userId: undefined, organizationId: undefined, ipAddress: undefined },
      target: { type: 'ORGANIZATION', id: undefined },
      requestId: 'maintenance-1',
    });

    expect(unscoped).toHaveBeenCalledTimes(1);
    expect(unscoped.mock.calls[0]?.[0].action).toBe('rls.bypassed');
  });

  it('still becomes a row when it does name one and the scope agrees', async () => {
    const create = vi.fn().mockResolvedValue({});
    const unscoped = vi.fn<RecordFn>().mockResolvedValue(undefined);
    const logger = loggerFor(unscoped);

    await withTenant(fakeClient(create), { organizationId: ORG, userId: null }, async () => {
      await logger.record({
        action: 'rls.bypassed',
        actor: { userId: undefined, organizationId: ORG, ipAddress: undefined },
        target: { type: 'ORGANIZATION', id: undefined },
        requestId: 'maintenance-2',
      });
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(unscoped).not.toHaveBeenCalled();
  });
});

/**
 * The list itself, asserted as a list.
 *
 * The cases above prove the guard behaves: the one listed action reaches the log, an unlisted one is
 * refused. They do **not** notice the list growing — adding an action to it keeps every one of them
 * green, because each names its own action. That is the shape of change worth catching: the set is a
 * security policy, and widening it is a decision, not a detail.
 *
 * `toEqual` on the whole set rather than «contains»: an entry added here has to be deleted from this
 * expectation in the same change, which is where a reviewer is asked whether the reason written in
 * the constant's docstring is a real one.
 */
describe('the list of actions allowed without an organization', () => {
  it('holds exactly what its docstring justifies, and nothing that crept in', () => {
    expect(
      [...AUDIT_ACTIONS_WITHOUT_ORGANIZATION].sort(),
      'adding an action here means a privileged event may become a rotating log line instead of a row — say why in the constant, then change this expectation',
    ).toEqual(['rls.bypassed']);
  });
});
