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
 * Nine paths spend a point before an argon2id computation, and the rule is identical on all of them:
 * a refusal that never reached the hasher is not an attempt. Written out nine times it is nine
 * places to get the condition subtly wrong, and — the failure that actually happens — one place a
 * tenth path forgets to copy. `test/unit/application/hash-refusal-refund.test.ts` holds the list of
 * nine and fails when a tenth appears without it.
 *
 * ## What it must wrap, and what it must not
 *
 * Everything between the `consume` and the matching `reset`, and nothing after. The point is only
 * there to be returned while it is still spent; a refund issued after `reset` has already cleared
 * the counter would write a *negative* consumption and quietly grant the next window an extra
 * attempt. Paths that never reset (registration, invitation acceptance) may wrap to the end.
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
