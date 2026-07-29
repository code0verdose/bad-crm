/** The value that goes into the link, and the digest that goes into the row. Never the other way. */
export interface MintedResetToken {
  /** Base64url, so it survives a URL path segment untouched. Exists in the mail and nowhere else. */
  readonly token: string;
  readonly hash: Uint8Array;
}

/**
 * The single-use credential of `POST /auth/reset-password`.
 *
 * A port of its own rather than a reuse of `RefreshTokenPort`, although the construction is the
 * same — thirty-two CSPRNG bytes, SHA-256 at rest. The two values live under different rules and are
 * checked by different code, and a shared name would make it a coin flip which set a reader has in
 * mind: a refresh token travels only in an httpOnly cookie and lives thirty days; this one travels
 * through somebody's *mailbox*, appears in a URL a person can see and paste, and is spent by the
 * first click within an hour.
 *
 * **SHA-256 and not Argon2id**, for the reason the refresh digest gives: the cost of a password hash
 * buys resistance to enumeration, and a value with 256 bits from `randomBytes` cannot be enumerated
 * — so the cost would be paid on every reset and bought nothing. It also makes the lookup a plain
 * equality on a unique index, which is what lets an unknown token be answered exactly like a spent
 * one.
 */
export interface ResetTokenPort {
  mint(): MintedResetToken;
  hash(token: string): Uint8Array;
}
