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
  /**
   * What the store holds for `key`, or `null` when it holds nothing.
   *
   * Read before a refund and for nothing else. `reward` below cannot be asked "only if there is
   * something to give back" — it is an unconditional increment by a negative number — so the
   * question has to be asked separately, and the answer decides whether the decrement happens at
   * all (`rate-limiter.adapter.ts`, `refund`).
   */
  get(key: string): Promise<LimiterReading | null>;
  /** Refuses `key` for `secDuration`, replacing whatever was left of the current window. */
  block(key: string, secDuration: number): Promise<LimiterReading>;
  /**
   * Adds `-points` to the counter — the library's own name for un-consuming, and what
   * `RateLimitPort.refund` is built on.
   *
   * **Not "gives points back inside the window that is already open", which is what this said until
   * a reading of `RateLimiterRedis._upsert` showed otherwise.** The decrement is an `incrby` behind
   * `set key 0 EX ttl NX`, so against a key that is not there it *creates* one holding a negative
   * count with a full fresh window. The caller is responsible for not asking when there is nothing
   * to give back.
   */
  reward(key: string, points: number): Promise<LimiterReading>;
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
