import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { HmacAddressHasher } from '@/infrastructure/crypto/address-hasher.adapter.js';
import { Sha256RefreshTokenAdapter } from '@/infrastructure/crypto/refresh-token.adapter.js';

const KEY = `${'A'.repeat(43)}=`;
const OTHER_KEY = `${'B'.repeat(43)}=`;

describe('the refresh token', () => {
  it('mints a fresh secret every time', () => {
    const tokens = new Sha256RefreshTokenAdapter();
    const minted = Array.from({ length: 16 }, () => tokens.mint().token);

    expect(new Set(minted).size).toBe(16);
  });

  it('is 32 bytes of randomness in a cookie-safe alphabet', () => {
    const { token } = new Sha256RefreshTokenAdapter().mint();

    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('stores the SHA-256 of the token and never the token', () => {
    const tokens = new Sha256RefreshTokenAdapter();
    const { token, hash } = tokens.mint();

    expect(Buffer.from(hash)).toEqual(createHash('sha256').update(token, 'utf8').digest());
    expect(hash).toHaveLength(32);
    expect(Buffer.from(hash).toString('utf8')).not.toContain(token);
  });

  it('hashes a presented token to the same value it stored', () => {
    const tokens = new Sha256RefreshTokenAdapter();
    const { token, hash } = tokens.mint();

    expect(Buffer.from(tokens.hash(token))).toEqual(Buffer.from(hash));
    expect(Buffer.from(tokens.hash(`${token}x`))).not.toEqual(Buffer.from(hash));
  });
});

describe('the address hash', () => {
  it('is stable for one address and different for another', () => {
    const hasher = new HmacAddressHasher(KEY);

    expect(hasher.hash('203.0.113.42')).toBe(hasher.hash('203.0.113.42'));
    expect(hasher.hash('203.0.113.42')).not.toBe(hasher.hash('203.0.113.43'));
  });

  /**
   * The property the whole choice rests on: without the key, the digest of an address cannot be
   * recomputed. An unkeyed SHA-256 would let anybody holding the dump enumerate all 2^32 IPv4
   * addresses and read the column back.
   */
  it('cannot be recomputed without the installation key', () => {
    const address = '203.0.113.42';

    expect(new HmacAddressHasher(KEY).hash(address)).not.toBe(
      new HmacAddressHasher(OTHER_KEY).hash(address),
    );
    expect(new HmacAddressHasher(KEY).hash(address)).not.toBe(
      createHash('sha256').update(address, 'utf8').digest('hex'),
    );
  });

  it('answers for an address the deployment did not provide', () => {
    const hasher = new HmacAddressHasher(KEY);

    expect(hasher.hash(undefined)).toBe(hasher.hash(''));
    expect(hasher.hash(undefined)).toMatch(/^[0-9a-f]{64}$/);
  });
});
