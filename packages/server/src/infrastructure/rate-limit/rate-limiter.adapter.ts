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
