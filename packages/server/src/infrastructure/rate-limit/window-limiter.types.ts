import { type RateLimitPolicy } from '@/application/platform/ports/rate-limit.port.js';

/** What one call to the counter store reports back. `RateLimiterRes` satisfies it structurally. */
export interface LimiterReading {
  readonly remainingPoints: number;
  readonly msBeforeNext: number;
  readonly consumedPoints: number;
}

/**
 * The slice of `rate-limiter-flexible` the adapter uses.
 *
 * Narrow on purpose. `RateLimiterRedis` satisfies it as it stands — no wrapper, no delegation — and
 * declaring it lets the unit suite drive the adapter with an in-memory double that reproduces the
 * *rejection contract*: a `RateLimiterRes` when the subject is over its budget, a plain `Error` when
 * the store itself failed. That distinction is the entire fail-closed decision, and testing it
 * against a real Redis alone would mean the branch is only exercised on a machine with Docker.
 *
 * What a double can never reproduce — that the counter is shared by every replica — is asserted
 * where it belongs, in `test/integration/rate-limit/**`.
 */
export interface WindowLimiter {
  consume(key: string): Promise<LimiterReading>;
  /** Refuses `key` for `secDuration`, replacing whatever was left of the current window. */
  block(key: string, secDuration: number): Promise<LimiterReading>;
  delete(key: string): Promise<boolean>;
}

export interface PolicyLimiters {
  /** The budget itself. */
  readonly attempts: WindowLimiter;
  /**
   * How many times this subject has been locked out lately — a counter, not a limit.
   *
   * Separate from `attempts` because the two have different lifetimes: the budget resets every
   * fifteen minutes, and the memory of being locked out has to outlive it, or every lock-out would
   * be the first one and the block would never grow.
   */
  readonly penalties: WindowLimiter;
}

export type WindowLimiters = Readonly<Record<RateLimitPolicy, PolicyLimiters>>;
