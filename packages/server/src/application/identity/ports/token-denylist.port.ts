/**
 * A store that remembers "this identifier is spent" for a bounded time.
 *
 * **The first denylist in this repository (STORY-013-03).** `rules/security.mdc` rule 9 already
 * describes a Redis denylist of session ids for logout and password-change revocation, and today
 * that property is delivered a different way — through `Session.revokedAt`, read on every request
 * by `AuthenticateSessionQuery`, which answers the same question with strictly more authority than a
 * second store could (see that file's own note on why the row is the mechanism and Redis remains an
 * optimisation nobody needed yet).
 *
 * The mfa-pending token has no row behind it. It is a bearer credential minted for the five minutes
 * between a correct password and a correct second factor, and nothing in Postgres represents "this
 * sign-in attempt" before a `Session` exists — so single use has to be enforced by a store that
 * outlives nothing on its own and has to be told to forget.
 *
 * Deliberately generic rather than named after `jti`: the key is whatever the caller decides
 * identifies the thing being spent, namespaced by the caller (`JwtMfaPendingTokenAdapter` prefixes
 * its keys), so a second consumer — the `sid` denylist rule 9 already anticipates — can share the
 * implementation without this port knowing anything about JWTs.
 */
export interface TokenDenylistPort {
  /**
   * Makes `key` answer `isRevoked` `true` for at least `ttlSeconds`, never less.
   *
   * "Never less" is the whole point of taking a TTL rather than owning a fixed one: a shorter TTL
   * would let the denylist entry expire before the credential it is standing in for does, which for
   * a signature-verified bearer token means it starts verifying again on its own — the store forgot
   * before the thing it was told to forget stopped being dangerous.
   */
  revoke(key: string, ttlSeconds: number): Promise<void>;

  /**
   * Whether `key` was already revoked.
   *
   * **Must never resolve `false` when the answer could not actually be checked.** An implementation
   * that treated an unreachable store as "not revoked" would make "take the store down" the cheapest
   * way to defeat single use — the same reasoning `RedisRateLimiterAdapter` documents for the
   * brute-force limiter, applied to a different property. The contract is: answer `true`, answer
   * `false`, or reject. Never resolve `false` for "could not tell".
   */
  isRevoked(key: string): Promise<boolean>;
}
