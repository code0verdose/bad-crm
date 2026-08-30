import { describe, expect, it } from 'vitest';

import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import {
  ARGON2_MINIMUM,
  Argon2PasswordHasher,
} from '@/infrastructure/crypto/argon2-password-hasher.adapter.js';
import { createHashSemaphore } from '@/infrastructure/crypto/argon2-semaphore.util.js';
import { LimitedPasswordHasher } from '@/infrastructure/crypto/limited-password-hasher.adapter.js';

/**
 * `login-flood-memory` — the load test of STORY-013-06, acceptance 6.
 *
 * ## What is being measured, and why it is not the real hasher
 *
 * The claim under test is about **memory**, so the flood runs against a stand-in that allocates the
 * same 19 MiB per computation and holds it for the life of the call. That makes the claim a
 * measurement rather than an assertion about a number nobody weighed: without the ceiling the flood
 * below holds sixty-four buffers at once, and `process.memoryUsage()` says so.
 *
 * The real `Argon2PasswordHasher` is exercised too, at the end, on a smaller flood — the ceiling has
 * to hold around the adapter the process actually runs, not only around a double.
 *
 * ## Why the peak is counted at our boundary and not at libuv's
 *
 * `@node-rs/argon2` runs the async form on the libuv threadpool, which today happens to be four
 * threads wide, so somebody could argue the memory is bounded already. It is not a control:
 * `UV_THREADPOOL_SIZE` is an environment variable an operator may set to 1024, the pool is shared
 * with every `fs` and `dns` call in the process, and nothing in `PasswordHasherPort` promises any of
 * it. What this file measures is the number of computations **admitted** by our own ceiling, which
 * is the thing this codebase controls and the thing that can be removed to make the test red.
 *
 * ## Proof of red
 *
 * Removing the semaphore — handing the use-cases the bare hasher instead of `LimitedPasswordHasher`
 * — makes both assertions below fail: the peak becomes the size of the flood, and the resident set
 * grows with it. Recorded in `docs/brain/2026-08-30--argon2-concurrency-guard.md`.
 */

/** KiB → bytes, the unit `Argon2Parameters.memoryCost` is stated in. */
const BYTES_PER_COMPUTATION = ARGON2_MINIMUM.memoryCost * 1024;

const FLOOD = 64;
const CEILING = 4;

/**
 * A hasher that costs what argon2id costs in the only dimension this test is about: it allocates
 * 19 MiB, touches every page so the pages are real rather than promised by the allocator, and holds
 * them until the caller lets go.
 */
class AllocatingHasher implements PasswordHasherPort {
  readonly dummyHash = '$argon2id$dummy';

  live = 0;
  peak = 0;
  /** Bytes allocated and not yet released, and the highest that number ever reached. */
  held = 0;
  peakHeld = 0;

  /** Read back out of the buffer so nothing may decide the allocation is unused and elide it. */
  sink = 0;

  async verify(): Promise<boolean> {
    const held = Buffer.allocUnsafe(BYTES_PER_COMPUTATION);

    this.live += 1;
    this.held += BYTES_PER_COMPUTATION;
    this.peak = Math.max(this.peak, this.live);
    this.peakHeld = Math.max(this.peakHeld, this.held);

    try {
      held.fill(1);
      await new Promise((resolve) => setTimeout(resolve, 20));

      this.sink += (held[0] ?? 0) + (held.at(-1) ?? 0);

      return false;
    } finally {
      this.live -= 1;
      this.held -= BYTES_PER_COMPUTATION;
    }
  }

  hash(): Promise<string> {
    return Promise.resolve(this.dummyHash);
  }

  needsRehash(): boolean {
    return false;
  }
}

const limited = (inner: PasswordHasherPort): PasswordHasherPort =>
  new LimitedPasswordHasher(
    inner,
    createHashSemaphore({ maxConcurrency: CEILING, queueTimeoutMs: 30_000 }),
  );

describe('login-flood-memory', () => {
  /**
   * First in the file, and deliberately so. The resident set of a process only ever grows within a
   * run — an earlier flood that allocated a gigabyte leaves the baseline of every later measurement
   * a gigabyte high, and the assertion then passes for a reason that has nothing to do with the
   * ceiling. Measured once, against a baseline nothing in this file has touched yet.
   */
  it('does not grow with the size of the flood', async () => {
    const inner = new AllocatingHasher();
    const hasher = limited(inner);

    const before = process.memoryUsage().rss;
    let highWater = before;

    const sampler = setInterval(() => {
      highWater = Math.max(highWater, process.memoryUsage().rss);
    }, 5);

    try {
      await Promise.all(
        Array.from({ length: FLOOD }, async () => hasher.verify(inner.dummyHash, 'guess')),
      );
    } finally {
      clearInterval(sampler);
    }

    const unbounded = FLOOD * BYTES_PER_COMPUTATION;
    const bounded = CEILING * BYTES_PER_COMPUTATION;

    // What was actually alive at the worst moment, counted at the allocation itself. This is the
    // claim: the flood holds four buffers, not sixty-four, whatever the allocator does afterwards.
    expect(inner.peakHeld).toBe(bounded);

    // And the process agrees. Generous headroom on purpose — the two numbers are an order of
    // magnitude apart, so the assertion does not turn on the garbage collector's timing or on what
    // else the machine is running.
    expect(highWater - before).toBeLessThan(unbounded / 2);
  });

  it('holds the peak at the ceiling while a flood of sign-ins runs', async () => {
    const inner = new AllocatingHasher();
    const hasher = limited(inner);

    await Promise.all(
      Array.from({ length: FLOOD }, async () => hasher.verify(inner.dummyHash, 'guess')),
    );

    expect(inner.peak).toBe(CEILING);
  });

  /** The same ceiling around the adapter the process really runs, at the real cost. */
  it('holds around the real argon2id adapter as well', async () => {
    const real = new Argon2PasswordHasher(ARGON2_MINIMUM);
    let live = 0;
    let peak = 0;

    const counted: PasswordHasherPort = {
      dummyHash: real.dummyHash,
      hash: async (password: string) => real.hash(password),
      needsRehash: (digest: string) => real.needsRehash(digest),
      verify: async (digest: string, password: string) => {
        live += 1;
        peak = Math.max(peak, live);

        try {
          return await real.verify(digest, password);
        } finally {
          live -= 1;
        }
      },
    };

    const hasher = limited(counted);

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, async () => hasher.verify(real.dummyHash, 'guess')),
    );

    expect(peak).toBe(CEILING);
    expect(outcomes.every((matched) => !matched)).toBe(true);
  }, 30_000);
});
