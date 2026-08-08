import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AesFieldEncryption } from '@/infrastructure/crypto/field-encryption.adapter.js';

/**
 * Field encryption at rest — the category that is **not** the vault.
 *
 * The vault is end-to-end encrypted and the server holds no key for it (invariant 3). This is the
 * other one: data the server legitimately reads to do its job, kept out of a database dump. Three
 * properties carry it, and each one is a way the primitive is usually got wrong:
 *
 *   * **the IV is fresh every time.** GCM's security collapses entirely if one repeats under the
 *     same key, and the same value encrypted twice is exactly when a deterministic IV would repeat;
 *   * **the tag is checked.** A row somebody edited in the database must fail to decrypt rather than
 *     decrypt to something else;
 *   * **«cannot read» is not «was empty».** Folding them together turns a lost key into a field
 *     nobody investigates.
 */

const key = (): string => randomBytes(32).toString('base64');

describe('encrypting a field', () => {
  it('round-trips a value', () => {
    const crypto = new AesFieldEncryption(key());

    expect(crypto.decrypt(crypto.encrypt('+7 900 000-00-00, sister'))).toBe(
      '+7 900 000-00-00, sister',
    );
  });

  it('leaves an absent value absent rather than encrypting an empty string', () => {
    const crypto = new AesFieldEncryption(key());

    expect(crypto.encrypt(null)).toBeNull();
    expect(crypto.decrypt(null)).toBeNull();
  });

  it('never stores the plaintext', () => {
    const crypto = new AesFieldEncryption(key());

    expect(crypto.encrypt('sister: Olga')).not.toContain('Olga');
  });

  it('produces a different ciphertext every time, because the IV is fresh', () => {
    // The property GCM depends on absolutely: two encryptions of one value under one key must not
    // share an IV, or the pair of ciphertexts leaks the plaintext.
    const crypto = new AesFieldEncryption(key());
    const first = crypto.encrypt('same value');
    const second = crypto.encrypt('same value');

    expect(first).not.toBe(second);
    expect(crypto.decrypt(first)).toBe(crypto.decrypt(second));
  });

  it('writes the version prefix, so the key can ever be rotated', () => {
    const crypto = new AesFieldEncryption(key());

    expect(crypto.encrypt('x')).toMatch(/^v1:/);
  });
});

describe('reading a field back', () => {
  it('refuses a value whose tag does not match', () => {
    // A row edited in the database by hand. GCM is what turns that into a refusal rather than into
    // a different plaintext.
    const crypto = new AesFieldEncryption(key());
    const [version, iv, tag] = (crypto.encrypt('sister: Olga') ?? '').split(':');
    const tampered = [version, iv, tag, Buffer.from('another value').toString('base64')].join(':');

    expect(() => crypto.decrypt(tampered)).toThrow();
  });

  it('refuses a value written under a different key', () => {
    const written = new AesFieldEncryption(key()).encrypt('sister: Olga');

    expect(() => new AesFieldEncryption(key()).decrypt(written)).toThrow();
  });

  it.each([
    ['a value of another format version', 'v2:aaaa:bbbb:cccc'],
    ['a truncated column', 'v1:aaaa'],
    ['something that is not encrypted at all', 'sister: Olga'],
  ])('refuses %s rather than answering null', (_case, stored) => {
    const crypto = new AesFieldEncryption(key());

    expect(() => crypto.decrypt(stored)).toThrow();
  });
});

describe('the key itself', () => {
  it('is refused at construction when it is the wrong length', () => {
    // At start-up rather than months later, in the request of the first person who fills the field
    // in — a failure that would look completely unrelated to the key.
    expect(() => new AesFieldEncryption(randomBytes(24).toString('base64'))).toThrow(/32 bytes/);
  });
});
