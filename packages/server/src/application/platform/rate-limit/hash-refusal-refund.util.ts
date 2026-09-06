import {
  type RateLimitPolicy,
  type RateLimitPort,
  type RateLimitSubjects,
} from '@/application/platform/ports/rate-limit.port.js';
import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';

/**
 * The dependency name the argon2 ceiling refuses under (`argon2-semaphore.util.ts`).
 *
 * Matched on rather than on the class, because `ServiceUnavailableError` is also what an unreachable
 * Redis raises — and that one is thrown *by* `consume`, before a point is taken, so refunding it
 * would hand back a point nobody spent.
 */
const HASH_DEPENDENCY = 'password-hashing';

const refusedBeforeHashing = (failure: unknown): boolean =>
  failure instanceof ServiceUnavailableError && failure.details?.['dependency'] === HASH_DEPENDENCY;

/**
 * Runs the part of a use-case that hashes, and gives the attempt back if the queue refused it.
 *
 * ## Why the wrapper, rather than a `try` in each use-case
 *
 * Ten paths spend a point before an argon2id computation, and the rule is identical on all of them:
 * a refusal that never reached the hasher is not an attempt. Written out ten times it is ten places
 * to get the condition subtly wrong, and — the failure that actually happens — one place an
 * eleventh path forgets to copy. `test/unit/application/hash-refusal-refund.test.ts` does not hold a
 * list: it walks `src`, derives the paths that both spend a point and can reach a hasher, and fails
 * on the day one of them appears without this wrapper. The hand-kept list it replaced was already
 * one path short — `verify-second-factor.use-case.ts` hashes nothing itself and delegates to a
 * use-case that hashes ten times, which is exactly the shape a list written by eye misses.
 *
 * ## What the refund does and does not claim
 *
 * **What it claims:** a refused request never *completed* an attempt — no verdict on the credential
 * ever reached the caller, and the work was abandoned mid-way — so the caller must not lose one of
 * the attempts the budget rations. That holds on all ten paths, and it is the whole of the property.
 *
 * It is deliberately **not** phrased as "no credential was judged", which would be false: on
 * `change-password` the current password has already verified when the refusal lands on hashing the
 * new one, and on the recovery-code paths up to nine digests — possibly including the matching one —
 * have already been compared. Judging is not the same as answering, and only the answer is what an
 * attempt is counted for.
 *
 * **What it does not claim:** that the returned point bought no computation. It bought none on three
 * of the ten — `register-organization`, `confirm-password-reset` and `accept-invitation`, which hash
 * exactly once and are refused at that one hash. On the other seven the refusal can arrive after
 * work that was already done and is now thrown away:
 *
 * - one on `change-password` — the current password verified, the new one refused;
 * - up to seven on `login`, which verifies every account sharing the address, sequentially and
 *   without an early exit (`verifyAll`); the count is bounded by the `LIMIT 8` in
 *   `auth_lookup_users_by_email`, and moves with it — it is not one hash, and never was;
 * - up to nine on `consume-recovery-code` and on `verify-second-factor`'s recovery branch, refused
 *   on the tenth of the ten fixed-cost comparisons;
 * - up to ten on `confirm-totp`, `regenerate-recovery-codes` and `disable-totp`.
 *
 * Ten is today's ceiling, and it is a reading of the code rather than a design limit: it moves with
 * `RECOVERY_CODE_COUNT` and with that `LIMIT 8`. None of it is reducible by moving this wrapper —
 * those computations are sequential by design, and a refusal can land between any two of them. The
 * budget therefore bounds *attempts*, not *arithmetic*; the KDF ceiling in `argon2-semaphore.util.ts`
 * is what bounds the arithmetic, and `RR-10` in the threat model records what neither of them bounds.
 *
 * ## What it must wrap, and what it must not
 *
 * Everything between the `consume` and the matching `reset`, and nothing after — *including* work
 * that hashes before the transaction opens, such as minting a batch of recovery codes. That mint is
 * ten queued computations, by a wide margin the likeliest place on its path to meet a refusal, and
 * it sat one line above this wrapper on two paths until it was moved inside. A refund issued after
 * `reset` has already cleared the counter is refused by the adapter rather than written as a
 * negative consumption (`rate-limiter.adapter.ts`), but the ordering is still the caller's to get
 * right. Paths that never reset (registration, invitation acceptance) may wrap to the end.
 *
 * Nesting two wrappers is safe as long as the policies differ: each refunds its own counter once,
 * and a refusal travelling out through three of them is returned on three separate subjects, never
 * twice on the same one (`verify-second-factor.use-case.ts` is the case in point).
 *
 * The refusal itself is always re-thrown: the caller still gets its `503` with the `Retry-After`
 * the queue computed, and the client still backs off. What changes is only that backing off is no
 * longer punished (`rate-limit.port.ts`, `refund`).
 */
export const refundingHashRefusals = async <P extends RateLimitPolicy, T>(
  rateLimit: RateLimitPort,
  policy: P,
  subject: RateLimitSubjects[P],
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (failure) {
    if (refusedBeforeHashing(failure)) await rateLimit.refund(policy, subject);

    throw failure;
  }
};
