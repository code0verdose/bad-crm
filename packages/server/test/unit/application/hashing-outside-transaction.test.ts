import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  type TenantScope,
  type UnitOfWorkPort,
} from '@/application/platform/ports/unit-of-work.port.js';
import { ConsumeRecoveryCodeUseCase } from '@/application/identity/use-cases/consume-recovery-code.use-case.js';
import { RecoveryCodeMatcher } from '@/application/identity/use-cases/recovery-code-matcher.use-case.js';
import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';

import { createHashSemaphore } from '@/infrastructure/crypto/argon2-semaphore.util.js';
import { LimitedPasswordHasher } from '@/infrastructure/crypto/limited-password-hasher.adapter.js';
import { createPromMetrics } from '@/infrastructure/metrics/prom-client.adapter.js';

import {
  FakeAuditLogger,
  FakeClock,
  FakeMailDispatcher,
  FakePasswordHasher,
  FakeRateLimit,
  FakeUsers,
  ORGANIZATION_ID,
  RecordingLogger,
  USER_ID,
} from '../../support/identity-doubles.util.js';
import { FakeRecoveryCodes } from '../../support/mfa-doubles.util.js';

const ACTOR = { organizationId: ORGANIZATION_ID, userId: USER_ID };
const VALID_CODE = 'ABCDE23456';
const APP_URL = 'https://crm.example.test';

/** Short enough to keep the suite instant, long enough to be an order of magnitude apart. */
const QUEUE_TIMEOUT_MS = 40;
const TRANSACTION_BUDGET_MS = 15;

/**
 * `withTenant` with the ceiling the real one has: an interactive transaction that outlives its
 * budget is killed by the database, and what the caller then sees is `P2028`, not whatever the
 * callback was going to raise.
 *
 * The emulation is a race and not a check after the fact, because that is the direction that
 * matters here: a callback still waiting in the argon2 queue when the budget expires has its own
 * refusal — the 503 with a `Retry-After` this system publishes — replaced by an unhandled driver
 * error, and the caller is answered 500. A double that only measured elapsed time afterwards would
 * let the callback's error win and would never reproduce that.
 */
class BudgetedUnitOfWork implements UnitOfWorkPort {
  readonly scopes: TenantScope[] = [];

  current: TenantScope | undefined;

  constructor(private readonly budgetMs: number) {}

  async withTenant<T>(scope: TenantScope, work: () => Promise<T>): Promise<T> {
    this.scopes.push(scope);
    this.current = scope;

    let expiry: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          expiry = setTimeout(() => {
            reject(
              Object.assign(new Error('Transaction already closed'), {
                code: 'P2028',
                name: 'PrismaClientKnownRequestError',
              }),
            );
          }, this.budgetMs);
          expiry.unref();
        }),
      ]);
    } finally {
      clearTimeout(expiry);
      this.current = undefined;
    }
  }
}

/** A hasher that records, per call, whether a tenant transaction was open while it ran. */
class ScopeWatchingHasher extends FakePasswordHasher {
  readonly verifiedInsideScope: boolean[] = [];

  constructor(private readonly unitOfWork: { current: TenantScope | undefined }) {
    super();
  }

  override verify(digest: string, password: string): Promise<boolean> {
    this.verifiedInsideScope.push(this.unitOfWork.current !== undefined);

    return super.verify(digest, password);
  }
}

const buildHarness = ({ saturated }: { readonly saturated: boolean }) => {
  const codes = new FakeRecoveryCodes();
  const unitOfWork = new BudgetedUnitOfWork(TRANSACTION_BUDGET_MS);
  const inner = new ScopeWatchingHasher(unitOfWork);
  const semaphore = createHashSemaphore({ maxConcurrency: 1, queueTimeoutMs: QUEUE_TIMEOUT_MS });

  if (saturated) {
    // The regime the ceiling was written for: the slot is taken and never handed back, so every
    // computation of this request queues for one.
    void semaphore.run(() => new Promise<void>(() => {})).catch(() => undefined);
  }

  const hasher = new LimitedPasswordHasher(inner, semaphore);
  const users = new FakeUsers();

  users.credentials.set(USER_ID, {
    email: 'ada@example.com',
    passwordHash: '$argon2id$hashed:irrelevant',
    locale: 'en',
  });

  const useCase = new ConsumeRecoveryCodeUseCase(
    new RecoveryCodeMatcher(codes, hasher),
    codes,
    users,
    unitOfWork,
    new FakeRateLimit(),
    new FakeClock(),
    new RecordingLogger(),
    new FakeAuditLogger(),
    createPromMetrics(),
    new FakeMailDispatcher(),
    APP_URL,
  );

  const id = randomUUID();

  codes.rows.set(id, {
    id,
    userId: USER_ID,
    codeHash: `$argon2id$hashed:${VALID_CODE}`,
    usedAt: null,
  });

  return { useCase, unitOfWork, inner };
};

/**
 * The property: an argon2id computation may not run inside an open transaction.
 *
 * Before STORY-013-06 a verification held its connection for the 50–80 ms it took to compute. With
 * the ceiling in place it may first wait `AUTH_ARGON2_QUEUE_TIMEOUT_MS` for a slot — and a recovery
 * code costs a fixed ten of them, each queueing separately, which is ten waits inside one
 * transaction whose whole budget is five seconds. The failure is qualitative, not a slow path: the
 * driver kills the transaction and the sign-in is answered `500 internal_error` instead of the
 * `503` with a `Retry-After` the queue produced and the client knows how to obey.
 */
describe('a saturated argon2 queue during a recovery-code sign-in', () => {
  it('refuses with the 503 the queue raised, not with a killed transaction', async () => {
    const { useCase } = buildHarness({ saturated: true });

    await expect(
      useCase.execute({ actor: ACTOR, code: VALID_CODE, ipAddress: '203.0.113.7' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('never asks the hasher for a verification while a transaction is open', async () => {
    const { useCase, inner } = buildHarness({ saturated: false });

    await useCase
      .execute({ actor: ACTOR, code: VALID_CODE, ipAddress: '203.0.113.7' })
      .catch(() => undefined);

    // CONTROL for the probe: it observed the ten verifications it exists to judge, so an empty
    // list cannot pass for «none of them was inside a scope».
    expect(inner.verifiedInsideScope.length).toBeGreaterThan(0);
    expect(inner.verifiedInsideScope).not.toContain(true);
  });
});
