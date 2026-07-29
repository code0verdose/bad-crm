import { type RateLimitEscalation } from '@/infrastructure/rate-limit/rate-limit-policy.constant.js';

/**
 * How long the subject stays refused after being locked out for the `breaches`-th time.
 *
 * `breaches` counts lock-outs remembered inside `memorySeconds`, so the first one is `1`. Zero is
 * accepted and treated as the first: the counter that produces this number lives in Redis, and a
 * failed write there must lengthen nothing rather than crash the refusal that is already correct.
 *
 * The growth is capped, and the cap is the whole reason this is a function rather than a
 * multiplication at the call site: `blockSeconds * factor ** breaches` overflows into weeks after a
 * dozen repeats, and a limiter that locks an account out until next month is a denial-of-service
 * tool handed to whoever can type an email address into a login form.
 */
export const escalatedBlockSeconds = (
  blockSeconds: number,
  escalation: RateLimitEscalation,
  breaches: number,
): number => {
  const repeats = Math.max(breaches - 1, 0);

  return Math.min(blockSeconds * escalation.factor ** repeats, escalation.maxBlockSeconds);
};
