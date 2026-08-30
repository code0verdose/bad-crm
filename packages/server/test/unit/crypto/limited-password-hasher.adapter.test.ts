import { describe, expect, it } from 'vitest';

import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import { createHashSemaphore } from '@/infrastructure/crypto/argon2-semaphore.util.js';
import { LimitedPasswordHasher } from '@/infrastructure/crypto/limited-password-hasher.adapter.js';

/** Records what was asked of it and, for the two calls that compute, how many ran together. */
class RecordingHasher implements PasswordHasherPort {
  readonly dummyHash = '$argon2id$dummy';
  readonly calls: string[] = [];

  live = 0;
  peak = 0;

  async hash(password: string): Promise<string> {
    this.calls.push(`hash:${password}`);

    return await this.measured(`$argon2id$hashed:${password}`);
  }

  async verify(digest: string, password: string): Promise<boolean> {
    this.calls.push(`verify:${digest}`);

    return await this.measured(digest === `$argon2id$hashed:${password}`);
  }

  needsRehash(digest: string): boolean {
    this.calls.push(`needsRehash:${digest}`);

    return digest === 'weak';
  }

  private async measured<T>(result: T): Promise<T> {
    this.live += 1;
    this.peak = Math.max(this.peak, this.live);

    try {
      await new Promise((resolve) => setTimeout(resolve, 5));

      return result;
    } finally {
      this.live -= 1;
    }
  }
}

const limited = (inner: PasswordHasherPort, maxConcurrency = 2): PasswordHasherPort =>
  new LimitedPasswordHasher(inner, createHashSemaphore({ maxConcurrency, queueTimeoutMs: 5_000 }));

describe('the hasher behind the ceiling', () => {
  it('answers a verification with what the wrapped hasher answered', async () => {
    const inner = new RecordingHasher();
    const hasher = limited(inner);

    await expect(hasher.verify('$argon2id$hashed:right', 'right')).resolves.toBe(true);
    await expect(hasher.verify('$argon2id$hashed:right', 'wrong')).resolves.toBe(false);
  });

  /**
   * Hashing is inside the ceiling too, and it has to be: `POST /auth/register` is public, and a
   * ceiling that bounded only sign-in would leave the same 19 MiB allocation unbounded one route
   * over.
   */
  it('puts hashing under the same ceiling as verification', async () => {
    const inner = new RecordingHasher();
    const hasher = limited(inner);

    const digests = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => hasher.hash(`secret-${index}`)),
    );

    expect(inner.peak).toBe(2);
    expect(digests[0]).toBe('$argon2id$hashed:secret-0');
  });

  it('shares one queue between hashing and verification', async () => {
    const inner = new RecordingHasher();
    const hasher = limited(inner, 1);

    await Promise.all([
      hasher.hash('secret'),
      hasher.verify('$argon2id$hashed:secret', 'secret'),
      hasher.hash('another'),
    ]);

    expect(inner.peak).toBe(1);
  });

  /**
   * `needsRehash` computes nothing — it reads the cost fields out of a digest string. Taking a slot
   * for it would spend the ceiling on work that allocates no memory, and on the sign-in path it
   * would do so **inside** the open transaction of the re-hash.
   */
  it('lets needsRehash through without taking a slot', () => {
    const inner = new RecordingHasher();
    const hasher = limited(inner, 1);

    expect(hasher.needsRehash('weak')).toBe(true);
    expect(hasher.needsRehash('$argon2id$strong')).toBe(false);
    expect(inner.peak).toBe(0);
    expect(inner.calls).toEqual(['needsRehash:weak', 'needsRehash:$argon2id$strong']);
  });

  /**
   * The digest the sign-in verifies against when the address matches nobody. Re-exposed rather than
   * recomputed: it is what keeps the equalising branch reachable through the decorator, and it is a
   * value the wrapped hasher produced once at construction (STORY-013-06, acceptance 3).
   */
  it('exposes the wrapped hasher own dummy digest', () => {
    const inner = new RecordingHasher();

    expect(limited(inner).dummyHash).toBe(inner.dummyHash);
  });
});
