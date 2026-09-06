import { describe, expect, it } from 'vitest';

import { cachedReading } from '../../../src/infrastructure/metrics/cached-reading.util.js';

/**
 * The rate limit in front of the one metric that has to ask the database for its value.
 *
 * Everything else on `/metrics` is counted as the process works; the size of the audit trail is not
 * knowable that way, so it is read on demand — and «on demand» means on the schedule of whoever is
 * scraping. These are the four properties that make that safe, and each of them is a way the
 * endpoint has gone wrong elsewhere: a query per scrape, a query per concurrent scrape, a gap in the
 * series after one failure, and a rejected `collect` taking the whole exposition with it.
 */
describe('a reading cached between scrapes', () => {
  const clock = (): { now: () => number; advance: (ms: number) => void } => {
    let value = 1_000;

    return {
      now: () => value,
      advance: (ms: number) => {
        value += ms;
      },
    };
  };

  it('reads once and serves the same value until the window expires', async () => {
    const time = clock();
    let reads = 0;
    const reading = cachedReading({
      read: () => {
        reads += 1;

        return Promise.resolve(reads * 10);
      },
      maxAgeMs: 60_000,
      now: time.now,
    });

    await expect(reading()).resolves.toBe(10);
    time.advance(59_000);
    await expect(reading()).resolves.toBe(10);

    expect(reads).toBe(1);
  });

  it('refreshes once the value is older than the window', async () => {
    const time = clock();
    let reads = 0;
    const reading = cachedReading({
      read: () => {
        reads += 1;

        return Promise.resolve(reads * 10);
      },
      maxAgeMs: 60_000,
      now: time.now,
    });

    await reading();
    time.advance(60_001);

    await expect(reading()).resolves.toBe(20);
    expect(reads).toBe(2);
  });

  it('makes two callers arriving together share one read', async () => {
    const time = clock();
    let reads = 0;
    let release: (() => void) | undefined;
    const reading = cachedReading({
      read: async () => {
        reads += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });

        return 42;
      },
      maxAgeMs: 60_000,
      now: time.now,
    });

    const both = Promise.all([reading(), reading()]);

    release?.();

    await expect(both).resolves.toEqual([42, 42]);
    // Two scrapes landing on the same tick is what a busy moment looks like; two connections is not
    // what it should cost.
    expect(reads).toBe(1);
  });

  it('keeps the last value when a refresh fails, and retries on the next call', async () => {
    const time = clock();
    const results = [
      () => Promise.resolve(7),
      () => Promise.reject(new Error('connection reset')),
      () => Promise.resolve(9),
    ];
    let call = 0;
    const reading = cachedReading({
      read: () => (results[call++] ?? results[2])!(),
      maxAgeMs: 60_000,
      now: time.now,
    });

    await expect(reading()).resolves.toBe(7);
    time.advance(60_001);

    // Not `undefined` and not a rejection: a hole in this series reads as «zero bytes of audit
    // trail», which is both alarming and false, and a rejection here blanks every other metric on
    // the endpoint.
    await expect(reading()).resolves.toBe(7);
    // The failure was not cached — the window was not restarted by it, so the next caller tries.
    await expect(reading()).resolves.toBe(9);
  });

  it('answers undefined while nothing has ever been read', async () => {
    const reading = cachedReading({
      read: () => Promise.reject(new Error('database is down')),
      maxAgeMs: 60_000,
    });

    await expect(reading()).resolves.toBeUndefined();
  });
});
