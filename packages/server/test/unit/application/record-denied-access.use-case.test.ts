/**
 * The sink that puts a refusal in the trail — STORY-016-02 acceptance 7, and the audit half of
 * STORY-011-07 acceptance 2.
 *
 * Two things are asserted here that no other suite can assert: that a refusal writes **one** row
 * under the actor's own tenant scope, and that a run of them writes a bounded number. The second is
 * the whole reason this file is careful — a refusal is what an attacker provokes, so a writer that
 * wrote once per refusal would be a way of making somebody else's database do work for free.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  BURST_WINDOW_SECONDS,
  DENIAL_AUDIT_BUDGET,
  type DeniedAccess,
  RecordDeniedAccessUseCase,
} from '../../../src/application/access/use-cases/record-denied-access.use-case.js';
import { type AuditEvent } from '../../../src/application/platform/ports/audit-logger.port.js';
import {
  type RateLimitDecision,
  type RateLimitPort,
} from '../../../src/application/platform/ports/rate-limit.port.js';
import {
  type TenantScope,
  type UnitOfWorkPort,
} from '../../../src/application/platform/ports/unit-of-work.port.js';
import { ServiceUnavailableError } from '../../../src/domain/shared/errors/app.errors.js';
import { RATE_LIMIT_POLICY } from '../../../src/infrastructure/rate-limit/rate-limit-policy.constant.js';

const DENIAL: DeniedAccess = {
  reason: 'permission_not_granted',
  permissionKey: 'team:create',
  method: 'POST',
  actorUserId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
  organizationId: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
  ipAddress: '203.0.113.42',
  requestId: '01J8Z2F5Q3K9V6N0R4T7YB3XQD',
};

interface Harness {
  readonly service: RecordDeniedAccessUseCase;
  readonly written: AuditEvent[];
  readonly scopes: TenantScope[];
  readonly consumed: number[];
}

/** A limiter that spends a real budget, so «one row per run» is a property and not a stub. */
const harness = (budget = DENIAL_AUDIT_BUDGET, limiter?: Partial<RateLimitPort>): Harness => {
  const written: AuditEvent[] = [];
  const scopes: TenantScope[] = [];
  const consumed: number[] = [];
  let spent = 0;

  const rateLimit: RateLimitPort = {
    consume: (): Promise<RateLimitDecision> => {
      spent += 1;
      consumed.push(spent);

      return Promise.resolve(
        spent > budget
          ? { allowed: false, retryAfterSeconds: BURST_WINDOW_SECONDS }
          : { allowed: true, remaining: budget - spent },
      );
    },
    reset: () => Promise.resolve(),
    refund: () => Promise.resolve(),
    ...limiter,
  };

  const unitOfWork: UnitOfWorkPort = {
    withTenant: async <T>(scope: TenantScope, work: () => Promise<T>): Promise<T> => {
      scopes.push(scope);

      return await work();
    },
  };

  return {
    service: new RecordDeniedAccessUseCase({
      rateLimit,
      unitOfWork,
      audit: {
        record: (event: AuditEvent): Promise<void> => {
          written.push(event);

          return Promise.resolve();
        },
      },
    }),
    written,
    scopes,
    consumed,
  };
};

/**
 * The two constants above are a copy of the limiter's own numbers, in another layer. This is what
 * keeps them a copy rather than a second opinion: raising `points` without raising the constant
 * would leave `access.denial_burst` truthfully filed and wrongly worded — «collapsed after 10» on a
 * run that was collapsed after eleven.
 */
describe('the burst budget agrees with the policy it mirrors', () => {
  it('matches `access_denial_audit` point for point and second for second', () => {
    expect(DENIAL_AUDIT_BUDGET).toBe(RATE_LIMIT_POLICY.access_denial_audit.points);
    expect(BURST_WINDOW_SECONDS).toBe(RATE_LIMIT_POLICY.access_denial_audit.windowSeconds);
  });
});

describe('a refusal that the policy records', () => {
  it('writes one entry, under the tenant scope of the actor who was refused', async () => {
    const { service, written, scopes } = harness();

    await service.record(DENIAL);

    expect(written).toHaveLength(1);
    expect(scopes).toEqual([{ organizationId: DENIAL.organizationId, userId: DENIAL.actorUserId }]);
    expect(written[0]).toMatchObject({
      action: 'access.denied',
      actor: {
        userId: DENIAL.actorUserId,
        organizationId: DENIAL.organizationId,
        ipAddress: DENIAL.ipAddress,
      },
      target: { type: 'ORGANIZATION', id: undefined },
      after: {
        reason: 'permission_not_granted',
        permissionKey: 'team:create',
        method: 'POST',
        because: 'mutating_request',
      },
      requestId: DENIAL.requestId,
    });
  });

  /**
   * POSITIVE CONTROL, and the one that matters most: a sink that wrote unconditionally would pass
   * every assertion above. The refusal classes that are only a counter have to stay only a counter.
   */
  it('CONTROL: writes nothing at all for a refused read of an ordinary permission', async () => {
    const { service, written, consumed } = harness();

    await service.record({ ...DENIAL, method: 'GET', permissionKey: 'user:read' });

    expect(written).toEqual([]);
    // And it does not even spend a point: the cheap case must cost nothing, in Redis either.
    expect(consumed).toEqual([]);
  });

  it('CONTROL: writes nothing for an unauthenticated refusal', async () => {
    const { service, written } = harness();

    await service.record({ ...DENIAL, reason: 'not_authenticated', permissionKey: undefined });

    expect(written).toEqual([]);
  });

  it('records `null` where a refusal names no permission key', async () => {
    const { service, written } = harness();

    await service.record({ ...DENIAL, reason: 'not_the_owner', permissionKey: undefined });

    expect(written[0]?.after).toMatchObject({ permissionKey: null, reason: 'not_the_owner' });
  });

  /**
   * Stated positively — `toEqual` on the whole payload rather than `not.toContain` on the address —
   * for the reason `test/architecture/negated-optional-chain.test.ts` gives: a negated matcher over
   * a payload that turned out absent passes by saying nothing happened. An exact payload fails on an
   * empty write **and** on an extra field, which is the claim: the address reaches the hashed
   * column and nothing else.
   */
  it('never carries the address into the payload — it belongs to the hashed column', async () => {
    const { service, written } = harness();

    await service.record(DENIAL);

    expect(written[0]?.after).toEqual({
      reason: 'permission_not_granted',
      permissionKey: 'team:create',
      method: 'POST',
      because: 'mutating_request',
    });
  });
});

describe('a run of refusals from one actor', () => {
  it('collapses into one summary once the budget is spent, and stops writing after it', async () => {
    const { service, written } = harness();

    for (let attempt = 0; attempt < DENIAL_AUDIT_BUDGET * 5; attempt += 1) {
      await service.record(DENIAL);
    }

    expect(written).toHaveLength(DENIAL_AUDIT_BUDGET);
    expect(written.slice(0, -1).map((event) => event.action)).toEqual(
      Array.from({ length: DENIAL_AUDIT_BUDGET - 1 }, () => 'access.denied'),
    );
    expect(written.at(-1)).toMatchObject({
      action: 'access.denial_burst',
      after: { collapsedAfter: DENIAL_AUDIT_BUDGET - 1, windowSeconds: BURST_WINDOW_SECONDS },
    });
  });

  it('bounds what a refused caller can make the database write, however long they keep going', async () => {
    const { service, written } = harness();
    const attempts = 5000;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await service.record(DENIAL);
    }

    // The number this exists for: 5000 refusals, 11 rows.
    expect(written.length).toBe(DENIAL_AUDIT_BUDGET);
    expect(attempts / written.length).toBeGreaterThan(400);
  });
});

describe('when the machinery under the sink fails', () => {
  /**
   * The refusal already happened and the caller is already being told so. Turning a broken counter
   * store into a second failure would replace an answer the client can act on with one it cannot —
   * and, unlike a privileged action, a refusal that went unrecorded did not *do* anything.
   */
  it('propagates the failure to its caller rather than inventing a row', async () => {
    const { service } = harness(DENIAL_AUDIT_BUDGET, {
      consume: () => Promise.reject(new ServiceUnavailableError({ dependency: 'redis' })),
    });

    await expect(service.record(DENIAL)).rejects.toThrow(ServiceUnavailableError);
  });

  it('does not open a transaction when the budget could not be read', async () => {
    const { service, scopes } = harness(DENIAL_AUDIT_BUDGET, {
      consume: () => Promise.reject(new ServiceUnavailableError({ dependency: 'redis' })),
    });

    await service.record(DENIAL).catch(() => undefined);

    expect(scopes).toEqual([]);
  });
});

describe('the best-effort wrapper the HTTP surface holds', () => {
  it('swallows the failure, counts it, and never rejects into the response path', async () => {
    const { bestEffortDeniedAccessAudit } =
      await import('../../../src/application/access/use-cases/record-denied-access.use-case.js');
    const incrementAuditWriteFailed = vi.fn();
    const warn = vi.fn();
    const sink = bestEffortDeniedAccessAudit(
      { record: () => Promise.reject(new Error('redis is gone')) },
      {
        logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: vi.fn() } as never,
        metrics: { incrementAuditWriteFailed } as never,
      },
    );

    expect(() => {
      sink.record(DENIAL);
    }).not.toThrow();

    await vi.waitFor(() => {
      expect(incrementAuditWriteFailed).toHaveBeenCalledTimes(1);
    });
    expect(warn).toHaveBeenCalledTimes(1);
    // CONTROL: what it logs names the failure and never the caller's address.
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain(DENIAL.ipAddress);
  });

  it('CONTROL: passes a successful record through untouched', async () => {
    const { bestEffortDeniedAccessAudit } =
      await import('../../../src/application/access/use-cases/record-denied-access.use-case.js');
    const record = vi.fn(() => Promise.resolve());
    const incrementAuditWriteFailed = vi.fn();
    const sink = bestEffortDeniedAccessAudit(
      { record },
      {
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          child: vi.fn(),
        } as never,
        metrics: { incrementAuditWriteFailed } as never,
      },
    );

    sink.record(DENIAL);

    await vi.waitFor(() => {
      expect(record).toHaveBeenCalledWith(DENIAL);
    });
    expect(incrementAuditWriteFailed).not.toHaveBeenCalled();
  });
});
