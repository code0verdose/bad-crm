/** A freshly minted refresh token: the secret to hand out, and the digest to store. */
export interface MintedRefreshToken {
  /**
   * The opaque secret. It goes into `Set-Cookie` and nowhere else — not into a body, not into a log,
   * not into an audit record (CLAUDE.md, «Что нельзя логировать никогда»).
   */
  readonly token: string;
  /** SHA-256 of the token; the only form the database ever holds. */
  readonly hash: Uint8Array;
}

/**
 * The long-lived half of a session.
 *
 * Opaque rather than signed, and that is the point: a signed token is verifiable without a database
 * read, which is precisely what a token that must be *revocable* cannot afford. Rotation, reuse
 * detection and revocation all need the row, so the token carries no meaning of its own — it is a
 * lookup key into `sessions`, and the column holds its digest so that a dump of the table is not a
 * set of working credentials.
 */
export interface RefreshTokenPort {
  mint(): MintedRefreshToken;
  /** The stored form of a token presented by a browser. */
  hash(token: string): Uint8Array;
}
