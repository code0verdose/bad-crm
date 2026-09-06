import { describe, expect, it } from 'vitest';

import { LoginUseCase } from '@/application/identity/use-cases/login.use-case.js';
import { IssueSessionUseCase } from '@/application/identity/use-cases/issue-session.use-case.js';
import { refundingHashRefusals } from '@/application/platform/rate-limit/hash-refusal-refund.util.js';
import { type HashSemaphore } from '@/infrastructure/crypto/argon2-semaphore.util.js';
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
import {
  idleHashSemaphore,
  saturatedHashSemaphore,
} from '../../support/hash-semaphore-doubles.util.js';
import {
  filesUsingTheRefundWrapper,
  methodBodyOf,
  pathsThatSpendBeforeHashing,
} from '../../support/hashing-paths.util.js';
import { FakeMfaPendingTokens } from './second-factor-doubles.util.js';

/**
 * Derived once, at collection time, because `it.each` needs the list before any case runs.
 */
const hashingPaths = await pathsThatSpendBeforeHashing();

const PASSWORD = 'correct-horse-battery';
const EMAIL = 'ada@example.com';
const CLIENT = { userAgent: 'Firefox/128.0', ipAddress: '203.0.113.42' };

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
    const refused = signIn(saturatedHashSemaphore());

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        refused.execute({ email: EMAIL, password: PASSWORD, client: CLIENT }),
      ).rejects.toBeInstanceOf(ServiceUnavailableError);
    }

    // CONTROL: the budget really was consulted five times, so an assertion that the sixth attempt
    // is admitted cannot pass against a limiter nobody called.
    expect(rateLimit.consumed).toHaveLength(5);

    await expect(
      signIn(idleHashSemaphore()).execute({ email: EMAIL, password: PASSWORD, client: CLIENT }),
    ).resolves.toMatchObject({ status: 'authenticated' });
  });

  it('still spends it once the queue admits the request', async () => {
    const { signIn, rateLimit } = loginHarness();
    const admitted = signIn(idleHashSemaphore());

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
 * Every path that spends a point before Argon2id — derived from `src`, never listed here.
 *
 * ## What this asserts, exactly
 *
 * `pathsThatSpendBeforeHashing()` walks `packages/server/src`, seeds reachability with the one port
 * that costs Argon2id and closes over constructor injection and `implements`, then keeps the
 * use-cases that both spend a rate-limit point and hold something on that closure. Two things are
 * then asserted of each: that the refund wrapper appears in the file at all, and that inside
 * `execute` it appears **before** any call to a collaborator through which hashing is reachable.
 *
 * The second half is what a `toContain('refundingHashRefusals(')` alone could not say. A path may
 * wrap the transaction and still mint ten recovery codes — ten queued Argon2id computations, the
 * likeliest place in the whole flow to meet a refusal — one line above the wrapper, where a refusal
 * costs a point nobody gets back. That shipped, and shipped green, because the list was written by
 * hand and the check was a substring.
 *
 * ## What it still cannot say
 *
 * Hashing reached from a **private** method that `execute` calls outside the wrapper is invisible
 * here: the ordering question is asked of `execute`'s own text, and `this.completeSignIn(…)` is not
 * a collaborator call. The file-level assertion still catches a path with no wrapper at all, which
 * is how the tenth path was found; a path that wraps the wrong half of its own private helper is
 * not something this test would notice.
 */
describe('every path that spends a budget before hashing', () => {
  /**
   * CONTROL, and it runs the derivation backwards.
   *
   * Every assertion below is `it.each` over the derived list, and `it.each([])` reports nothing at
   * all rather than failing — a walk that silently stopped finding paths would turn this whole
   * describe green. Asserting a *number* here would put back the hand-kept count the walk replaced,
   * so the floor is derived too: every file that already carries the wrapper must be on the list.
   * A closure that narrowed, a glob that missed a directory, a regex that stopped matching a
   * constructor — each drops a file out of the list while leaving the wrapper in it, and each fails
   * here.
   */
  it('covers every file that already carries the wrapper', async () => {
    const carrying = await filesUsingTheRefundWrapper();

    expect(carrying).toContain('src/application/identity/use-cases/login.use-case.ts');
    expect(hashingPaths.map((entry) => entry.file).sort()).toEqual([...carrying].sort());
  });

  it.each(hashingPaths)('gives it back when the queue refuses: $file', ({ source }) => {
    expect(source).toContain('refundingHashRefusals(');
  });

  it.each(hashingPaths)('reaches no hasher before the refund is armed: $file', (entry) => {
    const execute = methodBodyOf(entry.source, 'execute');
    const armedAt = execute.indexOf('refundingHashRefusals(');

    // CONTROL: `execute` really was found and brace-matched. A method this parser missed comes back
    // as an empty string, every `indexOf` in the loop below returns `-1`, every collaborator is
    // skipped as unused, and the case reports green having asked nothing.
    expect(execute).toMatch(/^\{[\s\S]{80,}\}$/);

    for (const collaborator of entry.hashingCollaborators) {
      const usedAt = execute.indexOf(`this.${collaborator}.`);

      if (usedAt < 0) continue;

      // Named in the assertion rather than compared bare, so the failure says *which* collaborator
      // is reached too early instead of printing two offsets.
      expect({ collaborator, wrappedBeforeUse: armedAt > -1 && armedAt < usedAt }).toEqual({
        collaborator,
        wrappedBeforeUse: true,
      });
    }
  });
});
