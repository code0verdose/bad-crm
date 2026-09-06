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
 * The property, stated as narrowly as it is proved: **a recovery-code path may not run its argon2id
 * verifications inside an open transaction.** It is not the general rule "no argon2id inside any
 * transaction" — three paths in `src` deliberately keep one computation inside their transaction,
 * and the exposure is bounded and recorded below.
 *
 * Before STORY-013-06 a verification held its connection for the 50–80 ms it took to compute. With
 * the ceiling in place it may first wait `AUTH_ARGON2_QUEUE_TIMEOUT_MS` (2 000 ms by default) for a
 * slot — and a recovery code costs a fixed `RECOVERY_CODE_COUNT` of them, each queueing separately,
 * which is ten sequential waits, up to ~20 s, inside one transaction whose whole budget is five
 * seconds (`tenant.context.ts`, `DEFAULT_TIMEOUT_MS`). The failure is qualitative, not a slow path:
 * the driver kills the transaction and the sign-in is answered `500 internal_error` instead of the
 * `503` with a `Retry-After` the queue produced and the client knows how to obey.
 *
 * ## The three paths that keep one computation inside, and why that is accepted
 *
 * `ConfirmTotpUseCase` (`verifyPassword`, inside `confirm`), `RegenerateRecoveryCodesUseCase`
 * (`verifyPassword`, inside `regenerate`) and `ConfirmPasswordResetUseCase` (`hasher.hash`, inside
 * `spend`) each pay **exactly one** computation inside their transaction — the password branch and
 * the `dummyHash` branch are exclusive, so the count does not depend on whether the account exists.
 * The first two run it inside a `Promise.all` beside a non-argon2 check, so the waits overlap rather
 * than add. Worst case under a saturated queue is therefore one wait of `AUTH_ARGON2_QUEUE_TIMEOUT_MS`
 * (2 000 ms) plus one computation (50–80 ms) ≈ 2.1 s against a 5 s budget — the transaction survives
 * and the caller gets the `503`, which is what the recovery-code path could not do at ten waits.
 *
 * For `ConfirmPasswordResetUseCase` moving the hash out would be a regression, not a cleanup: the
 * hash sits **after** the reset token is spent on purpose, so a link presented a second time buys no
 * argon2id at all. Hoisting it ahead of the spend would hand an attacker replaying a used link a
 * free computation per request — the exact cost this ceiling exists to ration.
 *
 * Raising `AUTH_ARGON2_QUEUE_TIMEOUT_MS` past ~4 900 ms would put a single wait over the transaction
 * budget and turn these three into the same failure. That is what keeps the bound checkable: the
 * schema caps the variable at 60 000 ms, so an operator can configure it there, and this comment is
 * the record that the three paths were left in on the numbers above rather than overlooked.
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
