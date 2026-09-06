import { assert, describe, expect, it, vi } from 'vitest';

import { type AppError } from '@/domain/shared/errors/app.errors.js';
import {
  createHashSemaphore,
  type HashSemaphore,
} from '@/infrastructure/crypto/argon2-semaphore.util.js';

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

  /**
   * The floor under `Retry-After`, exercised at the only budget that reaches it: zero.
   *
   * A sub-second budget does **not** reach it, which is worth writing down because it reads as if it
   * should. `AUTH_ARGON2_QUEUE_TIMEOUT_MS` is a positive integer, and `Math.ceil(ms / 1000)` is
   * already 1 for every integer from 1 to 1000 — so no value the env schema admits can produce a
   * zero, and a case built at 500 ms asserts nothing about the floor at all. What the floor guards
   * is this utility's own contract: `createHashSemaphore` rejects a budget that is not a whole
   * number of milliseconds but **admits zero**, because "never wait" is degenerate rather than
   * incoherent, so a caller that is not the env schema can still hand it one. Then
   * `Retry-After: 0` would read as "retry now",
   * which is exactly the tight loop the refusal exists to break: the queue is refilled by the same
   * clients in the same millisecond.
   */
  it('never asks for less than a second back, even on a zero budget', async () => {
    vi.useFakeTimers();

    try {
      const semaphore = createHashSemaphore({ maxConcurrency: 1, queueTimeoutMs: 0 });
      const held = deferred();

      const running = semaphore.run(async () => held.promise);
      const settled = semaphore
        .run(() => Promise.resolve())
        .then(
          () => undefined,
          (error: unknown) => error as AppError,
        );

      await vi.advanceTimersByTimeAsync(0);

      const error = await settled;

      assert(error !== undefined, 'the queued computation must be refused');
      expect(error.retryAfterSeconds).toBe(1);

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
 * The other end of the same resource: a deadline bounds how *long* a waiter stays, and until
 * STORY-013-06's second pass nothing bounded how *many* of them there were. A parked request costs
 * ~27 KB of resident memory (measured: 500 of them through a `node:http` server added 26.2 MB RSS
 * for both ends of every socket in one process), so an unbounded queue is the exhausted memory the
 * ceiling exists to prevent, one layer up and in units nobody was counting.
 *
 * The bound is derived, not chosen: `maxConcurrency / cost` computations complete per second, so
 * `maxConcurrency × queueTimeoutMs / cost` is everything that can still be admitted before its own
 * deadline. A waiter past that position is refused now instead of holding a socket for the whole
 * budget in order to be refused then.
 */
describe('the bounded queue', () => {
  /**
   * The derivation the implementation must follow, restated rather than imported: a test that read
   * the same function would pass whatever that function did, including returning a constant.
   */
  const capacityFor = (maxConcurrency: number, queueTimeoutMs: number): number =>
    Math.ceil((maxConcurrency * queueTimeoutMs) / 15);

  /**
   * Sends arrivals one at a time until one is refused **without any timer being advanced**, and
   * reports how many were taken before that. The count is measured off the semaphore, not computed
   * by the test, which is what makes it able to fail: a capacity that ignored either knob, or was a
   * constant, lands on a different number.
   */
  const probeCapacity = async (
    maxConcurrency: number,
    queueTimeoutMs: number,
  ): Promise<{
    refusal: AppError | undefined;
    taken: number;
    release: () => void;
    semaphore: HashSemaphore;
  }> => {
    const semaphore = createHashSemaphore({ maxConcurrency, queueTimeoutMs });
    const gate = deferred();
    // Well past any capacity these cases configure, so a bound that vanished fails the assertion
    // instead of hanging the suite.
    const hardStop = 5_000;

    let refusal: AppError | undefined;
    let taken = 0;

    while (refusal === undefined && taken < hardStop) {
      let outcome: AppError | undefined;

      void semaphore
        .run(async () => gate.promise)
        .catch((error: unknown) => {
          outcome = error as AppError;
        });

      // Admission and the immediate refusal both settle within the microtask queue; a wait that
      // merely *expires* cannot, because no timer moves in this loop.
      await Promise.resolve();
      await Promise.resolve();

      if (outcome === undefined) taken += 1;
      else refusal = outcome;
    }

    return {
      refusal,
      taken,
      semaphore,
      release: () => {
        gate.release();
      },
    };
  };

  it('refuses the arrival that no longer fits instead of parking it', async () => {
    vi.useFakeTimers();

    try {
      const { refusal, release } = await probeCapacity(1, 300);

      // Refused *now*: no timer was advanced, so this cannot be the deadline firing.
      expect(refusal?.status).toBe(503);
      expect(refusal?.code).toBe('service_unavailable');
      expect(refusal?.retryAfterSeconds).toBe(1);

      release();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Both refusals are the same 503 to the client and must not be the same line in the log: an
   * operator reading `details` has to tell "waited and never got in" from "was never let into the
   * queue", because they call for different actions — more capacity against the first, a look at
   * where the traffic comes from against the second.
   */
  it('says in the log which of the two refusals it was', async () => {
    vi.useFakeTimers();

    try {
      const { refusal, release } = await probeCapacity(1, 300);

      assert(refusal !== undefined, 'the arrival past the cap must be refused');
      expect(refusal.details).toMatchObject({
        dependency: 'password-hashing',
        refusal: 'queue_full',
      });
      expect(refusal.details).not.toHaveProperty('waitedMs');

      release();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the other one too, when the wait is what ran out', async () => {
    vi.useFakeTimers();

    try {
      const semaphore = createHashSemaphore({ maxConcurrency: 1, queueTimeoutMs: 2_000 });
      const held = deferred();
      const running = semaphore.run(async () => held.promise);
      const settled = semaphore
        .run(() => Promise.resolve())
        .then(
          () => undefined,
          (error: unknown) => error as AppError,
        );

      await vi.advanceTimersByTimeAsync(2_000);

      const error = await settled;

      expect(error?.details).toMatchObject({
        dependency: 'password-hashing',
        refusal: 'wait_expired',
        waitedMs: 2_000,
      });

      held.release();
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The bound in both directions, which is the half a "past the cap it refuses" case leaves open:
   * the waiter one place *below* the derived length is still parked. Without it the suite passes on
   * any capacity smaller than the derivation — including one, which refuses traffic every default
   * installation is supposed to absorb.
   *
   * Reading the count off the semaphore is also what makes the derivation itself falsifiable: a
   * `queueCapacityOf` that dropped either knob, or returned a constant, gives a different number in
   * at least one of these three rows.
   */
  it.each([
    { maxConcurrency: 1, queueTimeoutMs: 300 },
    { maxConcurrency: 4, queueTimeoutMs: 300 },
    { maxConcurrency: 1, queueTimeoutMs: 2_000 },
  ])(
    'takes exactly the ceiling plus the derived queue length ($maxConcurrency slots, $queueTimeoutMs ms)',
    async ({ maxConcurrency, queueTimeoutMs }) => {
      vi.useFakeTimers();

      try {
        const { taken, refusal, release } = await probeCapacity(maxConcurrency, queueTimeoutMs);

        expect(taken).toBe(maxConcurrency + capacityFor(maxConcurrency, queueTimeoutMs));
        expect(refusal?.details).toMatchObject({ refusal: 'queue_full' });

        release();
        await vi.runAllTimersAsync();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  /**
   * The other argument the capacity divides. Until it started doing so, a non-integer budget only
   * cost a `setTimeout` Node clamps to 1 ms; now it makes the capacity `NaN`, `queued >= NaN` is
   * always `false`, and the length bound is off with nothing in the log to say so.
   */
  it('refuses a budget it cannot divide a capacity by', () => {
    expect(() => createHashSemaphore({ maxConcurrency: 4, queueTimeoutMs: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() => createHashSemaphore({ maxConcurrency: 4, queueTimeoutMs: -1 })).toThrow(
      RangeError,
    );
  });

  /**
   * A waiter whose deadline fired has given its place back. Counting the array instead of the live
   * waiters would keep the queue "full" of requests that left — the ceiling leaking downwards, the
   * same failure the expired-waiter skip in `release` was written for, only in the other dimension.
   */
  it('gives the place of a timed-out waiter back to the next arrival', async () => {
    vi.useFakeTimers();

    try {
      const { refusal, release, semaphore } = await probeCapacity(1, 300);

      expect(refusal).toBeDefined();

      // Every parked waiter runs out of budget here, and none of them is holding a place any more.
      await vi.advanceTimersByTimeAsync(300);

      const admitted = semaphore
        .run(() => Promise.resolve('let in'))
        .catch((error: unknown) => {
          throw error;
        });

      release();
      await vi.advanceTimersByTimeAsync(0);

      await expect(admitted).resolves.toBe('let in');
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes how many are waiting, as it rises and falls', async () => {
    const queued: number[] = [];
    const semaphore = createHashSemaphore({
      maxConcurrency: 1,
      queueTimeoutMs: 5_000,
      onQueuedChange: (waiting) => queued.push(waiting),
    });
    const gate = deferred();

    const flood = [
      semaphore.run(async () => gate.promise),
      semaphore.run(async () => gate.promise),
      semaphore.run(async () => gate.promise),
    ];

    await Promise.resolve();
    expect(Math.max(...queued)).toBe(2);

    gate.release();
    await Promise.all(flood);

    expect(queued.at(-1)).toBe(0);
  });

  /** The queue gauge is an observer too: a broken one may not cost the slot it was announcing. */
  it('does not lose a slot when the queue gauge throws', async () => {
    const semaphore = createHashSemaphore({
      maxConcurrency: 1,
      queueTimeoutMs: 5_000,
      onQueuedChange: () => {
        throw new Error('gauge is broken');
      },
    });
    const gate = deferred();

    const first = semaphore.run(async () => gate.promise);
    const second = semaphore.run(() => Promise.resolve('behind'));

    await Promise.resolve();
    gate.release();

    await expect(second).resolves.toBe('behind');
    await first;
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

/**
 * The gauge is an observer of the ceiling, never a participant in it.
 *
 * `Gauge.set` of a finite number does not throw today, which is the only reason this is not an
 * incident already — but the cost is not symmetric with the guard. Publication sits in the middle
 * of accounting for a slot at both ends, and an exception escaping from there is the one failure
 * this whole utility exists to prevent: a slot counted with nobody running it. It never comes back,
 * `AUTH_ARGON2_MAX_CONCURRENCY` of them close the door for good, and the only cure is a restart.
 */
describe('a gauge that throws', () => {
  const throwingGauge = (): (() => never) => {
    return () => {
      throw new Error('gauge is broken');
    };
  };

  it('does not cost the slot whose arrival it was announcing', async () => {
    const semaphore = createHashSemaphore({
      maxConcurrency: 1,
      queueTimeoutMs: 5_000,
      onInFlightChange: throwingGauge(),
    });

    // Two in a row through the same single slot: the second can only run if the first gave its slot
    // back, so this fails on a lost slot as well as on the escaping exception.
    await expect(semaphore.run(() => Promise.resolve('first'))).resolves.toBe('first');
    await expect(semaphore.run(() => Promise.resolve('second'))).resolves.toBe('second');
  });

  /**
   * The other end of the same connection, and the damage there is different in kind. `release` runs
   * inside `run`'s `finally`, and an exception thrown out of a `finally` **replaces** whatever the
   * block was carrying: a completed sign-in becomes a 500, and a genuine failure disappears behind
   * the gauge's.
   */
  it('keeps the outcome of the computation when it throws on the way down', async () => {
    const readings: number[] = [];
    const semaphore = createHashSemaphore({
      maxConcurrency: 1,
      queueTimeoutMs: 5_000,
      onInFlightChange: (inFlight) => {
        readings.push(inFlight);

        if (inFlight === 0) throw new Error('gauge is broken');
      },
    });

    await expect(semaphore.run(() => Promise.resolve('kept'))).resolves.toBe('kept');
    await expect(semaphore.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

    // And the readings kept coming: a throwing gauge is not silently unsubscribed from either.
    expect(readings).toEqual([1, 0, 1, 0]);
  });

  /**
   * The hand-over path publishes nothing — `inFlight` is unchanged when a slot moves from one
   * computation to the next — so this asserts the consequence rather than the mechanism: a queue
   * that was entered while the gauge was throwing still drains.
   */
  it('still hands a freed slot to the waiter behind it', async () => {
    const semaphore = createHashSemaphore({
      maxConcurrency: 1,
      queueTimeoutMs: 5_000,
      onInFlightChange: throwingGauge(),
    });
    const held = deferred();

    const running = semaphore.run(async () => held.promise);
    const queued = semaphore.run(() => Promise.resolve('behind'));

    await Promise.resolve();
    held.release();

    await expect(queued).resolves.toBe('behind');
    await running;
  });
});
