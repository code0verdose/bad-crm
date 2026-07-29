import { describe, expect, it } from 'vitest';

import {
  ARGON2_MINIMUM,
  Argon2PasswordHasher,
} from '@/infrastructure/crypto/argon2-password-hasher.adapter.js';

/**
 * The password hash, held to the two properties EPIC-006 accepts it on.
 *
 * 1. **argon2id, at or above the OWASP floor.** The parameters are configuration, so the adapter has
 *    to refuse a configuration below the floor rather than quietly hash weaker: an installation that
 *    lowered `ARGON2_MEMORY_COST` to make the container fit would otherwise ship hashes nobody can
 *    tell apart from the strong ones afterwards.
 * 2. **A raised parameter does not lock anybody out.** Old digests keep verifying and are re-hashed
 *    on the next successful sign-in — the epic acceptance criterion, and the only reason raising the
 *    cost is a decision an operator can actually take.
 */

const PASSWORD = 'correct-horse-battery-staple';

/** A digest at the lowest settings the adapter allows — the "legacy" one a raised cost replaces. */
const legacyDigest = (): Promise<string> => new Argon2PasswordHasher(ARGON2_MINIMUM).hash(PASSWORD);

describe('the password hasher', () => {
  it('produces an argon2id digest carrying the configured parameters', async () => {
    const hasher = new Argon2PasswordHasher(ARGON2_MINIMUM);
    const digest = await hasher.hash(PASSWORD);

    expect(digest.startsWith('$argon2id$')).toBe(true);
    expect(digest).toContain(`m=${ARGON2_MINIMUM.memoryCost}`);
    expect(digest).toContain(`t=${ARGON2_MINIMUM.timeCost}`);
    expect(digest).not.toContain(PASSWORD);
  });

  it('verifies the password it hashed and refuses another one', async () => {
    const hasher = new Argon2PasswordHasher(ARGON2_MINIMUM);
    const digest = await hasher.hash(PASSWORD);

    await expect(hasher.verify(digest, PASSWORD)).resolves.toBe(true);
    await expect(hasher.verify(digest, `${PASSWORD}!`)).resolves.toBe(false);
  });

  /**
   * A digest that is not one — a truncated column, a marker written by a fixture — is a refusal and
   * never an exception: it reaches `verify` on the sign-in path, where a throw would answer 500 and
   * separate "this account has a broken hash" from "wrong password" for anybody watching.
   */
  it('refuses a value that is not a digest instead of throwing', async () => {
    const hasher = new Argon2PasswordHasher(ARGON2_MINIMUM);

    await expect(hasher.verify('placeholder-not-a-credential', PASSWORD)).resolves.toBe(false);
  });

  it('refuses to run below the OWASP floor', () => {
    expect(
      () =>
        new Argon2PasswordHasher({
          ...ARGON2_MINIMUM,
          memoryCost: ARGON2_MINIMUM.memoryCost - 1,
        }),
    ).toThrow(/memoryCost/);

    expect(
      () => new Argon2PasswordHasher({ ...ARGON2_MINIMUM, timeCost: ARGON2_MINIMUM.timeCost - 1 }),
    ).toThrow(/timeCost/);

    expect(
      () =>
        new Argon2PasswordHasher({
          ...ARGON2_MINIMUM,
          parallelism: ARGON2_MINIMUM.parallelism - 1,
        }),
    ).toThrow(/parallelism/);
  });

  describe('when the parameters are raised', () => {
    it('still verifies a digest produced by the old ones', async () => {
      const digest = await legacyDigest();
      const raised = new Argon2PasswordHasher({
        ...ARGON2_MINIMUM,
        memoryCost: ARGON2_MINIMUM.memoryCost * 2,
      });

      await expect(raised.verify(digest, PASSWORD)).resolves.toBe(true);
    });

    it('reports that the digest has to be re-hashed', async () => {
      const digest = await legacyDigest();
      const raised = new Argon2PasswordHasher({
        ...ARGON2_MINIMUM,
        memoryCost: ARGON2_MINIMUM.memoryCost * 2,
      });

      expect(raised.needsRehash(digest)).toBe(true);
      expect(new Argon2PasswordHasher(ARGON2_MINIMUM).needsRehash(digest)).toBe(false);
    });

    /**
     * And the other direction: a digest stronger than the current configuration is left alone.
     * Re-hashing it would silently *weaken* the stored credential of everybody who signed in after
     * an operator rolled a parameter back.
     */
    it('leaves a stronger digest alone', async () => {
      const stronger = await new Argon2PasswordHasher({
        ...ARGON2_MINIMUM,
        timeCost: ARGON2_MINIMUM.timeCost + 1,
      }).hash(PASSWORD);

      expect(new Argon2PasswordHasher(ARGON2_MINIMUM).needsRehash(stronger)).toBe(false);
    });

    it('treats an unreadable digest as one to replace', async () => {
      expect(new Argon2PasswordHasher(ARGON2_MINIMUM).needsRehash('not-a-digest')).toBe(true);
    });
  });

  /**
   * The dummy digest is the constant-time half of "an unknown address answers like a wrong
   * password": the login use-case verifies against it when there is no user, so it has to be a real
   * argon2id hash at the configured cost and it must not match anything.
   */
  describe('the dummy digest', () => {
    it('is a real digest at the configured cost that no password matches', async () => {
      const hasher = new Argon2PasswordHasher(ARGON2_MINIMUM);

      expect(hasher.dummyHash.startsWith('$argon2id$')).toBe(true);
      expect(hasher.dummyHash).toContain(`m=${ARGON2_MINIMUM.memoryCost}`);
      await expect(hasher.verify(hasher.dummyHash, PASSWORD)).resolves.toBe(false);
      await expect(hasher.verify(hasher.dummyHash, '')).resolves.toBe(false);
    });
  });
});
