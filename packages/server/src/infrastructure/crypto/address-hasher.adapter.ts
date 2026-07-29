import { createHmac } from 'node:crypto';

import { type AddressHasherPort } from '@/application/identity/ports/address-hasher.port.js';

/**
 * HMAC-SHA256 of the address under an installation-wide key.
 *
 * **Keyed, and that is the whole design.** An unkeyed digest of an IPv4 address is reversible by
 * exhaustive search — the entire space is 2^32 — so `SHA-256(ip)` stored in a column is the address
 * stored in a column with extra steps, and the privacy rule of `CLAUDE.md` («Персональные данные»)
 * would be decorative. With the key held only by the installation, a stolen database yields values
 * that still compare equal to each other and to nothing else.
 *
 * The key is `APP_ENCRYPTION_KEY`, which the installation already has and already rotates as one
 * unit; a second secret to configure would be a second secret to lose. Rotating it makes old hashes
 * stop matching new ones, which for this column means "sessions from before the rotation no longer
 * group with sessions after it" — a display nuisance, not a failure.
 */
export class HmacAddressHasher implements AddressHasherPort {
  private readonly key: Buffer;

  constructor(key: string) {
    this.key = Buffer.from(key, 'base64');
  }

  /**
   * The digest, hex-encoded.
   *
   * An absent address hashes the empty string rather than returning a sentinel: the column is NOT
   * NULL, every row must hold a comparable value, and a sentinel would make every address-less
   * session look like the same device as every other one — which is what a shared constant would
   * mean. The empty string does exactly that too, and deliberately: those sessions genuinely carry
   * no address to distinguish them by, and the readable column already says `unknown`.
   */
  hash(address: string | undefined): string {
    return createHmac('sha256', this.key)
      .update(address ?? '', 'utf8')
      .digest('hex');
  }
}
