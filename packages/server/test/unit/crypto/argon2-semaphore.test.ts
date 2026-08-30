import { describe, expect, it, vi } from 'vitest';

import { type AppError } from '@/domain/shared/errors/app.errors.js';
import { createHashSemaphore } from '@/infrastructure/crypto/argon2-semaphore.util.js';

/**
 * The ceiling on how many argon2id computations may exist at once (STORY-013-06).
 *
 * The interesting number is the **peak**, never the average: 19 MiB is allocated for the life of one
 * computation, so an average of four with a spike of two hundred is 3.8 GiB resident for the length
 * of the spike, and an average is the one statistic that cannot see it. Every test here therefore
 * records the maximum of the concurrent count and asserts on that.
 */

/** A task that stays in flight until it is released by hand, so a peak can be held and measured. */
const deferred = (): { promise: Promise<void>; release: () => void } => {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });

  return { promise, release };
};

/** Counts admitted computations and remembers the highest number that ever ran together. */
const peakProbe = (): { peak: () => number; run: (task: () => Promise<void>) => Promise<void> } => {
  let live = 0;
  let peak = 0;

  return {
    peak: () => peak,
    run: async (task) => {
      live += 1;
      peak = Math.max(peak, live);

      try {
        await task();
      } finally {
        live -= 1;
      }
    },
  };
};

describe('the argon2 concurrency ceiling', () => {
  it('never lets more computations run at once than the configured limit', async () => {
    const semaphore = createHashSemaphore({ maxConcurrency: 3, queueTimeoutMs: 5_000 });
    const probe = peakProbe();
    const gate = deferred();

    const flood = Array.from({ length: 20 }, async () =>
      semaphore.run(async () => probe.run(async () => gate.promise)),
    );

    // Everything that could be admitted has been by now: the flood was created synchronously and
    // the microtask queue has drained.
    await Promise.resolve();
    await Promise.resolve();

    expect(probe.peak()).toBe(3);

    gate.release();
    await Promise.all(flood);

    // And the queue drained rather than deadlocking: the tail ran once slots came free, still
    // never more than three of them together.
    expect(probe.peak()).toBe(3);
  });

  /** CONTROL: the ceiling is the limit, not a coincidence of how the test schedules its tasks. */
  it('CONTROL: admits the whole flood at once when the limit is raised above it', async () => {
    const semaphore = createHashSemaphore({ maxConcurrency: 20, queueTimeoutMs: 5_000 });
    const probe = peakProbe();
    const gate = deferred();

    const flood = Array.from({ length: 20 }, async () =>
      semaphore.run(async () => probe.run(async () => gate.promise)),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(probe.peak()).toBe(20);

    gate.release();
    await Promise.all(flood);
  });

  it('queues the rest instead of running them, and runs them as slots come free', async () => {
    const semaphore = createHashSemaphore({ maxConcurrency: 1, queueTimeoutMs: 5_000 });
    const order: string[] = [];
    const first = deferred();

    const one = semaphore.run(async () => {
      order.push('one');
      await first.promise;
    });
    const two = semaphore.run(() => {
      order.push('two');

      return Promise.resolve();
    });

    await Promise.resolve();
    expect(order).toEqual(['one']);

    first.release();
    await Promise.all([one, two]);
    expect(order).toEqual(['one', 'two']);
  });

  it('refuses a construction that would admit nothing', () => {
    expect(() => createHashSemaphore({ maxConcurrency: 0, queueTimeoutMs: 1_000 })).toThrow(
      RangeError,
    );
  });
});

/**
 * An unbounded queue is the same exhausted memory one layer up: every waiting request still holds a
 * connection, a parsed body and a promise chain, and the client that gave up long ago is not told.
 */
describe('the bounded wait', () => {
  it('answers 503 with a Retry-After rather than waiting forever', async () => {
    vi.useFakeTimers();

    try {
      const semaphore = createHashSemaphore({ maxConcurrency: 1, queueTimeoutMs: 2_000 });
      const held = deferred();

      const running = semaphore.run(async () => held.promise);
      const queued = semaphore.run(() => Promise.resolve());

      const settled = queued.then(
        () => undefined,
        (error: unknown) => error as AppError,
      );

      await vi.advanceTimersByTimeAsync(2_000);

      const error = await settled;

      expect(error?.code).toBe('service_unavailable');
      expect(error?.status).toBe(503);
      expect(error?.retryAfterSeconds).toBe(2);

      held.release();
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  /** CONTROL: a wait that fits inside the budget still resolves; the timeout is not a hard cap. */
  it('CONTROL: admits a waiter that gets its slot before the deadline', async () => {
    vi.useFakeTimers();

    try {
      const semaphore = createHashSemaphore({ maxConcurrency: 1, queueTimeoutMs: 2_000 });
      const held = deferred();

      const running = semaphore.run(async () => held.promise);
      const queued = semaphore.run(() => Promise.resolve('admitted'));

      await vi.advanceTimersByTimeAsync(1_000);
      held.release();

      await expect(queued).resolves.toBe('admitted');
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A waiter that timed out must leave the queue. Left in it, its slot is handed over to nobody
   * when a computation finishes — the ceiling then leaks downwards until the process admits none.
   */
  it('skips a timed-out waiter and admits the one behind it', async () => {
    vi.useFakeTimers();

    try {
      const semaphore = createHashSemaphore({ maxConcurrency: 1, queueTimeoutMs: 2_000 });
      const held = deferred();
      const running = semaphore.run(async () => held.promise);

      // Two in the queue. The first will run out of budget; the second arrives a second later and
      // must get the slot the first one no longer wants.
      const abandoned = semaphore.run(() => Promise.resolve()).catch(() => 'gave up');

      await vi.advanceTimersByTimeAsync(1_000);

      const behind = semaphore.run(() => Promise.resolve('behind'));

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(abandoned).resolves.toBe('gave up');

      held.release();

      await expect(behind).resolves.toBe('behind');
      await running;
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The gauge exists so that saturation is visible *before* the host goes into OOM: `argon2_inflight`
 * sitting at the ceiling for minutes is the shape of a credential-stuffing run, and it is the only
 * evidence of it that survives the process being killed.
 */
describe('what the ceiling publishes', () => {
  it('reports the current number of computations as it rises and falls', async () => {
    const readings: number[] = [];
    const semaphore = createHashSemaphore({
      maxConcurrency: 2,
      queueTimeoutMs: 5_000,
      onInFlightChange: (inFlight) => readings.push(inFlight),
    });
    const gate = deferred();

    const flood = [
      semaphore.run(async () => gate.promise),
      semaphore.run(async () => gate.promise),
    ];

    await Promise.resolve();
    expect(readings).toEqual([1, 2]);

    gate.release();
    await Promise.all(flood);

    expect(readings.at(-1)).toBe(0);
    expect(Math.max(...readings)).toBe(2);
  });

  it('reports the count back down when a computation throws', async () => {
    const readings: number[] = [];
    const semaphore = createHashSemaphore({
      maxConcurrency: 2,
      queueTimeoutMs: 5_000,
      onInFlightChange: (inFlight) => readings.push(inFlight),
    });

    await expect(semaphore.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

    expect(readings.at(-1)).toBe(0);
  });
});
