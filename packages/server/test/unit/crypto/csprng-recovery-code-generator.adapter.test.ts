import { describe, expect, it } from 'vitest';

import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import { CsprngRecoveryCodeGenerator } from '@/infrastructure/crypto/csprng-recovery-code-generator.adapter.js';
import {
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_LENGTH,
} from '@/domain/identity/recovery-code.value.js';

/** A hasher that records what it was asked to hash and answers a deterministic, reversible digest. */
class RecordingHasher implements PasswordHasherPort {
  readonly hashed: string[] = [];

  readonly dummyHash = '$argon2id$dummy';

  hash(password: string): Promise<string> {
    this.hashed.push(password);

    return Promise.resolve(`$argon2id$hashed:${password}`);
  }

  verify(digest: string, password: string): Promise<boolean> {
    return Promise.resolve(digest === `$argon2id$hashed:${password}`);
  }

  needsRehash(): boolean {
    return false;
  }
}

describe('CsprngRecoveryCodeGenerator', () => {
  it('mints exactly the requested number of codes', async () => {
    const hasher = new RecordingHasher();
    const generator = new CsprngRecoveryCodeGenerator(hasher);

    const batch = await generator.generateBatch(10);

    expect(batch).toHaveLength(10);
  });

  it('draws every code from the recovery-code alphabet, at the documented length', async () => {
    const hasher = new RecordingHasher();
    const generator = new CsprngRecoveryCodeGenerator(hasher);

    const batch = await generator.generateBatch(5);
    const pattern = new RegExp(`^[${RECOVERY_CODE_ALPHABET}]{${RECOVERY_CODE_LENGTH}}$`);

    for (const code of batch) {
      expect(code.plaintext).toMatch(pattern);
    }
  });

  it('mints ten distinct plaintext codes', async () => {
    const hasher = new RecordingHasher();
    const generator = new CsprngRecoveryCodeGenerator(hasher);

    const batch = await generator.generateBatch(10);

    expect(new Set(batch.map((code) => code.plaintext)).size).toBe(10);
  });

  it('hashes every plaintext through the injected password hasher', async () => {
    const hasher = new RecordingHasher();
    const generator = new CsprngRecoveryCodeGenerator(hasher);

    const batch = await generator.generateBatch(3);

    expect(hasher.hashed).toEqual(batch.map((code) => code.plaintext));
    for (const code of batch) {
      expect(code.hash).toBe(`$argon2id$hashed:${code.plaintext}`);
    }
  });

  it('answers an empty batch for a count of zero', async () => {
    const hasher = new RecordingHasher();
    const generator = new CsprngRecoveryCodeGenerator(hasher);

    await expect(generator.generateBatch(0)).resolves.toEqual([]);
    expect(hasher.hashed).toEqual([]);
  });
});
