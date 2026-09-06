import { RateLimiterRes } from 'rate-limiter-flexible';

import {
  type LimiterReading,
  type WindowLimiter,
} from '@/infrastructure/rate-limit/window-limiter.types.js';

/**
 * An in-memory `WindowLimiter` with the rejection semantics of `rate-limiter-flexible`.
 *
 * The two are not interchangeable and this fake is deliberately not offered as one: what it
 * reproduces is the **shape** of the contract — a resolved reading below the limit, a rejected
 * `RateLimiterRes` above it, and a rejected plain `Error` when the store itself failed — which is
 * the discrimination the adapter is built on. That the real Redis-backed limiter counts across
 * processes is a property no in-memory double can have, and it is asserted where it can be:
 * `test/integration/rate-limit/**` against a real container.
 */
export class FakeWindowLimiter implements WindowLimiter {
  /** Set to make every call reject the way a driver does when the store is unreachable. */
  storeFailure: Error | undefined;

  /** Set to make `get` clear the key on its way out — the `reset` that races a refund. */
  clearBetweenReadAndReward = false;

  private readonly consumed = new Map<string, number>();
  private readonly expiresAt = new Map<string, number>();

  /**
   * A counter, not `Date.now()` — and that is the whole point.
   *
   * The clock used to be `Date.now()` plus an accumulated offset, so **real** time kept flowing
   * between `advance()` and the assertion that followed it. A case that advances to one millisecond
   * before the block expires then passes or fails depending on how long the process took to get to
   * the next line: measured, «rounds the last fraction of a second up» flaked about once in three
   * runs under load. A test whose verdict depends on machine speed teaches people to re-run the
   * suite, which is worse than the test not existing.
   *
   * The start is an arbitrary fixed instant. Zero would pass every case here today — checked — so
   * this is a precaution rather than a caught bug: a non-zero epoch keeps a future `if (!timestamp)`
   * from reading an initial instant as "unset".
   */
  private clock = 1_767_225_600_000;

  private readonly now = (): number => this.clock;

  constructor(
    private readonly points: number,
    private readonly windowMs: number,
  ) {}

  /** Moves the fake clock; the window expires without a timer and without real time passing. */
  advance(ms: number): void {
    this.clock += ms;
  }

  async consume(key: string): Promise<LimiterReading> {
    if (this.storeFailure !== undefined) throw this.storeFailure;

    const expiry = this.expiresAt.get(key);

    if (expiry === undefined || expiry <= this.now()) {
      this.consumed.set(key, 0);
      this.expiresAt.set(key, this.now() + this.windowMs);
    }

    const consumed = (this.consumed.get(key) ?? 0) + 1;
    this.consumed.set(key, consumed);

    const msBeforeNext = Math.max((this.expiresAt.get(key) ?? 0) - this.now(), 0);

    if (consumed > this.points) {
      throw new RateLimiterRes(0, msBeforeNext, consumed, false);
    }

    return Promise.resolve({
      remainingPoints: this.points - consumed,
      msBeforeNext,
      consumedPoints: consumed,
    });
  }

  async block(key: string, secDuration: number): Promise<LimiterReading> {
    if (this.storeFailure !== undefined) throw this.storeFailure;

    this.consumed.set(key, this.points + 1);
    this.expiresAt.set(key, this.now() + secDuration * 1000);

    return Promise.resolve({
      remainingPoints: 0,
      msBeforeNext: secDuration * 1000,
      consumedPoints: this.points + 1,
    });
  }

  /**
   * What the store holds for `key`, or `null` when the key is gone or its window has run out.
   *
   * Absence and expiry are the same answer here because they are the same answer in Redis: a key
   * whose TTL elapsed is a key that is not there.
   */
  async get(key: string): Promise<LimiterReading | null> {
    if (this.storeFailure !== undefined) throw this.storeFailure;

    const expiry = this.expiresAt.get(key);

    if (!this.consumed.has(key) || expiry === undefined || expiry <= this.now()) {
      return Promise.resolve(null);
    }

    const consumed = this.consumed.get(key) ?? 0;
    const reading = {
      remainingPoints: this.points - consumed,
      msBeforeNext: this.msBeforeNextFor(key),
      consumedPoints: consumed,
    };

    // The race the adapter's own guard cannot close, made reproducible: a `reset` that lands after
    // the read and before the decrement.
    if (this.clearBetweenReadAndReward) await this.delete(key);

    return reading;
  }

  /**
   * Adds `-points` to the counter, **including below zero and including onto a key that is not
   * there** — which is what `rate-limiter-flexible` does, not a liberty this double takes.
   *
   * This used to clamp at zero and say in this very docstring that the real adapter does the same.
   * It does not: `RateLimiterRedis._upsert` runs `incrby` behind `set key 0 EX ttl NX`, so a reward
   * against an absent key creates one holding minus one **with a full fresh window**, and the next
   * window opens one attempt richer. The clamp made that unreachable, which is precisely why no test
   * in this suite could see it. A double that describes production wrongly is not a weaker test — it
   * is the instrument every other test is measured with.
   */
  async reward(key: string, points: number): Promise<LimiterReading> {
    if (this.storeFailure !== undefined) throw this.storeFailure;

    // `set … NX` opens a fresh window for a key that was not there, and only for such a key.
    if (!this.consumed.has(key)) this.expiresAt.set(key, this.now() + this.windowMs);

    const consumed = (this.consumed.get(key) ?? 0) - points;

    this.consumed.set(key, consumed);

    return Promise.resolve({
      remainingPoints: this.points - consumed,
      msBeforeNext: this.msBeforeNextFor(key),
      consumedPoints: consumed,
    });
  }

  async delete(key: string): Promise<boolean> {
    if (this.storeFailure !== undefined) throw this.storeFailure;

    this.expiresAt.delete(key);

    return Promise.resolve(this.consumed.delete(key));
  }

  /** What the store holds for `key` right now — the observable result the assertions read. */
  consumedFor(key: string): number {
    return this.consumed.get(key) ?? 0;
  }

  /** Whether a counter exists at all, which `consumedFor` cannot say: absent and zero both read 0. */
  hasCounterFor(key: string): boolean {
    return this.consumed.has(key);
  }

  msBeforeNextFor(key: string): number {
    return Math.max((this.expiresAt.get(key) ?? 0) - this.now(), 0);
  }
}
