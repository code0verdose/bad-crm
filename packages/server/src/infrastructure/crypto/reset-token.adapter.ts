import { createHash, randomBytes } from 'node:crypto';

import {
  type MintedResetToken,
  type ResetTokenPort,
} from '@/application/identity/ports/reset-token.port.js';

/**
 * 32 bytes from the CSPRNG — the same 256 bits the refresh token gets, and for the same reason:
 * a value that cannot be enumerated does not need a slow hash behind it, and one that could be
 * guessed would not be saved by one.
 */
const TOKEN_BYTES = 32;

/**
 * The single-use reset credential: random bytes out, SHA-256 in.
 *
 * **base64url, and here it is not only about cookies.** This value is placed in a URL *path*
 * segment (`/reset-password/<token>`), so the alphabet has to survive a path untouched: `+` and `/`
 * of standard base64 are legal in a path but are re-encoded by half the mail clients that rewrite
 * links, and `=` padding is stripped by some of them outright. base64url has none of the three.
 *
 * **Plain SHA-256 at rest**, as `docs/architecture/data-model.md` §1 records for
 * `PasswordResetToken.tokenHash`: the digest exists so that a read of the table — a backup, a slow
 * query log, an injection — is not a set of live password resets, and 256 bits of `randomBytes`
 * leave nothing for an Argon2id cost to protect. It also keeps the lookup a plain equality on
 * `uq_password_reset_tokens_hash`, which is what lets an unknown token be answered exactly like a
 * spent one.
 */
export class Sha256ResetTokenAdapter implements ResetTokenPort {
  mint(): MintedResetToken {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');

    return { token, hash: this.hash(token) };
  }

  hash(token: string): Uint8Array {
    return createHash('sha256').update(token, 'utf8').digest();
  }
}
