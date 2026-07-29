import { createHash, randomBytes } from 'node:crypto';

import {
  type MintedRefreshToken,
  type RefreshTokenPort,
} from '@/application/identity/ports/refresh-token.port.js';

/**
 * 32 bytes from the CSPRNG — 256 bits of entropy, the same order as the digest that stores it.
 *
 * Guessing is therefore not a threat model this has to defend against, which is why the refresh
 * lookup may be a plain equality on a global unique index and why an unknown token is answered
 * exactly like a spent one.
 */
const TOKEN_BYTES = 32;

/**
 * The opaque refresh token: random bytes out, SHA-256 in.
 *
 * **Plain SHA-256 and not argon2id, deliberately.** A password hash is slow because a password has
 * perhaps forty bits of entropy and an offline attacker enumerates them; this value has 256 bits
 * from `randomBytes` and cannot be enumerated at all, so the cost would buy nothing and would be
 * paid on every single refresh. The same reasoning is written down for `Session.refreshTokenHash` in
 * `docs/architecture/data-model.md`.
 *
 * **base64url and not hex.** The value travels in a cookie, where the character set matters: `=`
 * and `+` in a cookie value are legal but routinely mangled by intermediaries, and base64url has
 * neither.
 */
export class Sha256RefreshTokenAdapter implements RefreshTokenPort {
  mint(): MintedRefreshToken {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');

    return { token, hash: this.hash(token) };
  }

  hash(token: string): Uint8Array {
    return createHash('sha256').update(token, 'utf8').digest();
  }
}
