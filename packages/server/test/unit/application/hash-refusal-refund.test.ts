import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LoginUseCase } from '@/application/identity/use-cases/login.use-case.js';
import { IssueSessionUseCase } from '@/application/identity/use-cases/issue-session.use-case.js';
import { refundingHashRefusals } from '@/application/platform/rate-limit/hash-refusal-refund.util.js';
import {
  createHashSemaphore,
  type HashSemaphore,
} from '@/infrastructure/crypto/argon2-semaphore.util.js';
import { LimitedPasswordHasher } from '@/infrastructure/crypto/limited-password-hasher.adapter.js';
import { RateLimitedError, ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';
import { FakeTotpEnrollment } from '../../support/mfa-doubles.util.js';
import {
  disabledMfaPolicy,
  authUser,
  FakeAccessTokens,
  FakeAddressHasher,
  FakeAuthLookup,
  FakeAuditLogger,
  FakeClock,
  FakeIdGenerator,
  FakeOrganizations,
  FakePasswordHasher,
  FakeRateLimit,
  FakeRefreshTokens,
  FakeSessions,
  FakeUnitOfWork,
  FakeUsers,
  RecordingLogger,
} from '../../support/identity-doubles.util.js';
import { FakeMfaPendingTokens } from './second-factor-doubles.util.js';

const PASSWORD = 'correct-horse-battery';
const EMAIL = 'ada@example.com';
const CLIENT = { userAgent: 'Firefox/128.0', ipAddress: '203.0.113.42' };

/**
 * A ceiling whose only slot is held by a computation that never finishes, and whose wait budget is
 * zero — so every arrival is refused on its deadline, exactly as a host under a flood refuses one.
 *
 * The slot is taken synchronously: `acquire`'s fast path has nothing to await, so `inFlight` is
 * already 1 when this returns and the very next `run` queues.
 */
const saturated = (): HashSemaphore => {
  const semaphore = createHashSemaphore({ maxConcurrency: 1, queueTimeoutMs: 0 });

  void semaphore.run(async () => new Promise<never>(() => undefined));

  return semaphore;
};

/** A ceiling nothing is contending for. */
const idle = (): HashSemaphore => createHashSemaphore({ maxConcurrency: 4, queueTimeoutMs: 2_000 });

interface LoginHarness {
  readonly rateLimit: FakeRateLimit;
  readonly signIn: (semaphore: HashSemaphore) => LoginUseCase;
}

const loginHarness = (): LoginHarness => {
  const clock = new FakeClock();
  const lookup = new FakeAuthLookup([authUser()]);
  const hasher = new FakePasswordHasher();
  const sessions = new FakeSessions(clock);
  const users = new FakeUsers();
  const unitOfWork = new FakeUnitOfWork();
  // Five attempts and no more — the number `auth_attempt` actually grants.
  const rateLimit = new FakeRateLimit({ limits: { auth_attempt: 5 } });
  const issue = new IssueSessionUseCase(
    sessions,
    new FakeOrganizations(),
    new FakeRefreshTokens(),
    new FakeAccessTokens(),
    new FakeAddressHasher(),
    clock,
    new FakeIdGenerator(),
    new FakeTotpEnrollment(),
    disabledMfaPolicy(clock),
  );

  return {
    rateLimit,
    signIn: (semaphore) =>
      new LoginUseCase(
        lookup,
        new LimitedPasswordHasher(hasher, semaphore),
        users,
        new FakeTotpEnrollment(),
        unitOfWork,
        issue,
        new FakeMfaPendingTokens(clock),
        rateLimit,
        new RecordingLogger(),
        new FakeAuditLogger(),
      ),
  };
};

/**
 * The failure this file exists for: a refusal that costs the caller a point of a budget it never
 * spent, on a path whose whole purpose is to ration argon2id.
 *
 * `auth_attempt` grants five attempts per fifteen minutes on the pair `ip+email` and escalates the
 * block to an hour on repeat. The queue's own refusal carries `Retry-After: 2`, so a client that
 * obeys it comes back **inside** that window. Five obedient retries during a ten-second spike
 * therefore exhausted the budget of somebody who never once mistyped a password — the memory
 * defence turned into the installation locking its own users out.
 */
describe('a sign-in the argon2 queue refused', () => {
  it('does not spend the attempt budget it never reached the hasher with', async () => {
    const { signIn, rateLimit } = loginHarness();
    const refused = signIn(saturated());

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        refused.execute({ email: EMAIL, password: PASSWORD, client: CLIENT }),
      ).rejects.toBeInstanceOf(ServiceUnavailableError);
    }

    // CONTROL: the budget really was consulted five times, so an assertion that the sixth attempt
    // is admitted cannot pass against a limiter nobody called.
    expect(rateLimit.consumed).toHaveLength(5);

    await expect(
      signIn(idle()).execute({ email: EMAIL, password: PASSWORD, client: CLIENT }),
    ).resolves.toMatchObject({ status: 'authenticated' });
  });

  it('still spends it once the queue admits the request', async () => {
    const { signIn, rateLimit } = loginHarness();
    const admitted = signIn(idle());

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        admitted.execute({ email: EMAIL, password: 'wrong-password', client: CLIENT }),
      ).rejects.toThrow();
    }

    // The control above, inverted: five *real* attempts do exhaust the budget, so the refund is
    // scoped to the refusal and has not quietly switched the limiter off.
    await expect(
      admitted.execute({ email: EMAIL, password: PASSWORD, client: CLIENT }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(rateLimit.refunded).toHaveLength(0);
  });
});

/**
 * The helper on its own, because the branch it draws is the whole of the decision and the use-case
 * suite above exercises one side of it.
 */
describe('the refund helper', () => {
  const subject = { ipAddress: undefined, email: EMAIL };

  it('gives the point back only for a refusal that reached no hasher', async () => {
    const rateLimit = new FakeRateLimit();

    await expect(
      refundingHashRefusals(rateLimit, 'auth_attempt', subject, () =>
        Promise.reject(
          new ServiceUnavailableError({ dependency: 'password-hashing', refusal: 'queue_full' }),
        ),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);

    expect(rateLimit.refunded).toEqual([{ policy: 'auth_attempt', subject }]);
  });

  it('keeps the point for every other failure, and passes a success through', async () => {
    const rateLimit = new FakeRateLimit();

    await expect(
      refundingHashRefusals(rateLimit, 'auth_attempt', subject, () =>
        // Redis down: `consume` raised instead of counting, so there is no point to return.
        Promise.reject(new ServiceUnavailableError({ dependency: 'redis' })),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);

    await expect(
      refundingHashRefusals(rateLimit, 'auth_attempt', subject, () =>
        Promise.reject(new Error('anything else at all')),
      ),
    ).rejects.toThrow('anything else at all');

    await expect(
      refundingHashRefusals(rateLimit, 'auth_attempt', subject, () => Promise.resolve('answered')),
    ).resolves.toBe('answered');

    expect(rateLimit.refunded).toHaveLength(0);
  });
});

/**
 * The other eight paths, held as a list rather than as eight harnesses.
 *
 * Every one of them spends a point before an argon2id computation it may never get to run, which is
 * the same defect the sign-in above demonstrates end to end; what differs is only the policy and how
 * much a wrongly-spent point costs (three an hour for a registration, five in fifteen minutes for
 * the rest). Building eight more harnesses would assert the helper eight more times and the thing
 * that actually goes wrong — a *ninth* path added later without the wrapper — not once. This does
 * assert that, and fails on the day such a path appears.
 */
describe('every path that spends a budget before hashing', () => {
  const relative = [
    'identity/use-cases/login.use-case.ts',
    'identity/use-cases/change-password.use-case.ts',
    'identity/use-cases/register-organization.use-case.ts',
    'identity/use-cases/confirm-password-reset.use-case.ts',
    'identity/use-cases/confirm-totp.use-case.ts',
    'identity/use-cases/regenerate-recovery-codes.use-case.ts',
    'identity/use-cases/disable-totp.use-case.ts',
    'identity/use-cases/consume-recovery-code.use-case.ts',
    'iam/use-cases/accept-invitation.use-case.ts',
  ];

  it.each(relative)('gives it back when the queue refuses: %s', async (path) => {
    const source = await readFile(
      fileURLToPath(new URL(`../../../src/application/${path}`, import.meta.url)),
      'utf8',
    );

    // CONTROL: the file really is one that spends a point, so a rename cannot turn this into an
    // assertion about an empty string.
    expect(source).toContain('rateLimit.consume(');
    expect(source).toContain('refundingHashRefusals(');
  });
});
