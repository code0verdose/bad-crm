import { RateLimiterRes } from 'rate-limiter-flexible';

import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import {
  type RateLimitDecision,
  type RateLimitPolicy,
  type RateLimitPort,
  type RateLimitSubjects,
} from '@/application/platform/ports/rate-limit.port.js';
import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';
import { escalatedBlockSeconds } from '@/infrastructure/rate-limit/rate-limit-escalation.util.js';
import {
  rateLimitKeyOf,
  type RateLimitKey,
} from '@/infrastructure/rate-limit/rate-limit-key.util.js';
import { RATE_LIMIT_POLICY } from '@/infrastructure/rate-limit/rate-limit-policy.constant.js';
import { type WindowLimiters } from '@/infrastructure/rate-limit/window-limiter.types.js';

/**
 * Seconds a client should wait, never zero.
 *
 * `Retry-After: 0` reads as "retry now", so a block with 300 ms left would invite exactly the
 * tight loop the limiter is spending its budget to stop. Rounded up for the same reason.
 */
const retryAfterSecondsOf = (msBeforeNext: number): number =>
  Math.max(Math.ceil(msBeforeNext / 1000), 1);

/**
 * `RateLimitPort` on Redis, through `rate-limiter-flexible`.
 *
 * The counter lives in Redis and nowhere else, which is the requirement rather than an
 * implementation detail: two replicas behind a load balancer must spend one budget of five
 * attempts, not five each (STORY-006-07). Nothing in this class holds state — a second instance in
 * a second process is the same limiter.
 *
 * **The failure policy is fail-closed, and it is here rather than in a configuration flag.**
 * `rate-limiter-flexible` rejects `consume` with a `RateLimiterRes` when the subject is over its
 * budget and with the driver's own error when the store could not be reached. The two are answered
 * differently on purpose: over budget is `429` with a `Retry-After`, unreachable is `503`. What
 * neither one is, ever, is `allowed: true` — a limiter that admits everybody while Redis is down
 * would make "take Redis down" the cheapest way to disable the brute-force defence
 * (`docs/security/threat-model.md`, T-IAM-03 and T-IAM-08).
 */
export class RedisRateLimiterAdapter implements RateLimitPort {
  constructor(
    private readonly limiters: WindowLimiters,
    private readonly logger: LoggerPort,
  ) {}

  async consume<P extends RateLimitPolicy>(
    policy: P,
    subject: RateLimitSubjects[P],
  ): Promise<RateLimitDecision> {
    const key = rateLimitKeyOf(policy, subject);

    try {
      const reading = await this.limiters[policy].attempts.consume(key.value);

      return { allowed: true, remaining: reading.remainingPoints };
    } catch (rejection) {
      if (!(rejection instanceof RateLimiterRes)) {
        // `error`, not `warn`: nobody can sign in until this is fixed, which is the level's
        // definition — "requires a human" (rules/observability.mdc, rule 7).
        this.logger.error(
          { policy, subject: key.label },
          'rate limiter store unavailable, refusing the request',
        );

        // The driver error travels as `cause` — into the log, never into the body: connection
        // errors quote connection strings, and connection strings quote passwords.
        throw new ServiceUnavailableError({ dependency: 'redis', policy }, rejection);
      }

      const retryAfterSeconds = await this.refuse(policy, key, rejection);

      this.logger.warn({ policy, subject: key.label, retryAfterSeconds }, 'rate limit exceeded');

      return { allowed: false, retryAfterSeconds };
    }
  }

  async reset<P extends RateLimitPolicy>(policy: P, subject: RateLimitSubjects[P]): Promise<void> {
    const key = rateLimitKeyOf(policy, subject);

    try {
      await this.limiters[policy].attempts.delete(key.value);
      await this.limiters[policy].penalties.delete(key.value);
    } catch {
      // Deliberately swallowed. This runs after a credential was accepted; raising here would turn
      // a correct sign-in into a 503, and the counter it failed to clear expires on its own.
      this.logger.warn(
        { policy, subject: key.label },
        'rate limit counters could not be cleared after a success',
      );
    }
  }

  async refund<P extends RateLimitPolicy>(policy: P, subject: RateLimitSubjects[P]): Promise<void> {
    const key = rateLimitKeyOf(policy, subject);
    const attempts = this.limiters[policy].attempts;
    /** Which of the three commands was in flight, so a swallowed failure still says what is left. */
    let stage: 'read' | 'return' | 'clean' = 'read';

    try {
      const current = await attempts.get(key.value);

      // Nothing left to give back, and asking anyway would hand out an attempt nobody paid for.
      // `reward` is `incrby -1` behind `set key 0 EX ttl NX` (`RateLimiterRedis._upsert`), so
      // against an absent key it *creates* one holding minus one with a **full fresh window** — the
      // next window then opens with six attempts instead of five. The key is absent whenever the
      // window expired under the queued request, or a parallel success of the same subject cleared
      // it with `reset` while this one was still waiting for a slot.
      if (current === null) return;

      // Already blocked, so there is no attempt to return — only harm. `block` writes exactly
      // `points + 1`; decrementing that to `points` buys nobody an admission, because the next
      // `consume` lands on `points + 1` again, and `refuse` reads that as "just exhausted" and takes
      // a second penalty point. The refund would lengthen the lock-out of the subject it is meant to
      // spare.
      if (current.consumedPoints > RATE_LIMIT_POLICY[policy].points) return;

      // The penalty counter is deliberately untouched — nothing escalated, because escalation
      // happens only on the request that exhausts the budget, and a refunded point by construction
      // belongs to a request that was admitted.
      stage = 'return';
      const returned = await attempts.reward(key.value, 1);

      // A `reset` that landed between the read and the decrement leaves behind the negative counter
      // the read was there to prevent. Deleting it restores "no key", which is what the window it
      // belonged to has already become.
      //
      // The read and the decrement are two commands, so this repairs one of the two orderings the
      // guards above cannot see and not the other: a `block` landing in the same gap still gets its
      // point back and can still lengthen itself once more. Closing that too would mean moving the
      // whole sequence into a Lua script on the server; it has not been done, and the port's
      // docstring says so rather than promising otherwise.
      if (returned.consumedPoints < 0) {
        stage = 'clean';
        await attempts.delete(key.value);
      }
    } catch {
      // Deliberately swallowed, like `reset`'s. The caller is already carrying a 503 of its own and
      // is about to raise it; replacing that with a different 5xx would tell the client less.
      //
      // `stage` is the operator's half of the message, and it is not decoration: the three failures
      // say different things about what is in the store. `read` is the only certain one — nothing
      // had been written yet, so the point stayed spent and expires with its window. `return` is
      // genuinely unknown: a driver that times out or loses the connection after sending `incrby`
      // raises here all the same, so the decrement may or may not have landed, and if the key had
      // meanwhile been cleared it may have landed as a counter of minus one with a fresh window.
      // `clean` is the case where that counter certainly exists and certainly was not removed — the
      // next window there opens an attempt richer. A single sentence covering all three would claim
      // certainty twice where there is none.
      this.logger.warn(
        { policy, subject: key.label, stage },
        'returning a rate limit point after a refused computation did not complete',
      );
    }
  }

  /**
   * How long the subject is refused for — the same block again, or a longer one.
   *
   * The block grows only when the budget was *just* exhausted, which `rate-limiter-flexible`
   * reports as `consumedPoints === points + 1` (the same test it uses internally to block once per
   * window). Escalating on every rejected request instead would reach the cap within seconds of a
   * client retrying in a loop, and a client retrying in a loop is the normal behaviour of a browser
   * with an open tab, not evidence of an attack.
   */
  private async refuse<P extends RateLimitPolicy>(
    policy: P,
    key: RateLimitKey,
    rejection: RateLimiterRes,
  ): Promise<number> {
    const definition = RATE_LIMIT_POLICY[policy];
    const escalation = definition.escalation;
    const justExhausted = rejection.consumedPoints === definition.points + 1;

    if (escalation === undefined || !justExhausted) {
      return retryAfterSecondsOf(rejection.msBeforeNext);
    }

    try {
      const breaches = await this.limiters[policy].penalties.consume(key.value);
      const blockSeconds = escalatedBlockSeconds(
        definition.blockSeconds,
        escalation,
        breaches.consumedPoints,
      );

      await this.limiters[policy].attempts.block(key.value, blockSeconds);

      return blockSeconds;
    } catch {
      // The refusal itself already happened and stands; only the escalation was lost. Answering
      // with the plain remaining window is the safe direction — shorter than intended, never
      // longer, and never an accidental admission.
      this.logger.warn(
        { policy, subject: key.label },
        'rate limit escalation could not be recorded, falling back to the base block',
      );

      return retryAfterSecondsOf(rejection.msBeforeNext);
    }
  }
}
