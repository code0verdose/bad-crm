/**
 * The intermediate credential of the second-factor step of sign-in.
 *
 * A correct password does not open a session by itself once TOTP is enabled — it opens a five-minute
 * window to prove the second factor, and this token is the proof that the first half already
 * happened (STORY-013-03, acceptance 1; `docs/security/threat-model.md`, T-IAM-04). No `Session` row
 * exists yet when it is issued, and none exists while it is being verified: it is a bearer credential
 * in its own right, not a variant of `AccessTokenClaims` with a different `scope` bolted on. Sharing
 * that shape was considered and rejected — the two tokens answer different questions
 * (`AccessTokenPort` says "who is this, in which session, with which rights"; this one says "which
 * sign-in attempt is still waiting for its second factor, and has it already been spent"), and
 * folding them together would leave a change to one claims shape accidentally widening or narrowing
 * the other's `asClaims`.
 */
export interface MfaPendingTokenSubject {
  /** The account that supplied a correct password and is now waiting on its second factor. */
  readonly userId: string;
  /** The organization the eventual session will be scoped to, carried the same way `AccessTokenClaims.organizationId` is. */
  readonly organizationId: string;
}

/** What a verified, unspent token says, plus what a caller needs to spend it afterwards. */
export interface MfaPendingTokenClaims extends MfaPendingTokenSubject {
  /** Unique per issued token — what the denylist keys on (STORY-013-03, acceptance 2, "одноразовость"). */
  readonly jti: string;
  /** When this token stops verifying on its own, TTL expiry aside — used to size the denylist entry. */
  readonly expiresAt: Date;
}

export interface IssuedMfaPendingToken {
  readonly token: string;
  readonly jti: string;
  readonly expiresInSeconds: number;
}

export interface MfaPendingTokenPort {
  /** Mints a fresh token for `subject`, good for five minutes (STORY-013-03, acceptance 1). */
  issue(subject: MfaPendingTokenSubject): Promise<IssuedMfaPendingToken>;

  /**
   * The claims of a token that verified **and has not already been spent**, or `undefined` for
   * anything else: bad signature, expired, wrong scope, or a `jti` the denylist already holds.
   *
   * One answer for all of them, on the same reasoning `AccessTokenPort.verify` documents — the
   * caller has the same thing to do in every case, and the shared catalog already collapses the
   * first three into a single code for the same reason (`mfa_token_expired`, "one code for all four
   * causes", `packages/shared/src/errors/error-code.enums.ts`). A reason string is a thing that ends
   * up in a response, and a response that told "expired" apart from "already used" would let a
   * caller confirm that a *particular* sign-in attempt was completed.
   *
   * Does not resolve at all — it rejects — when the denylist itself cannot be consulted. See the
   * implementation's own note on why that failure must never be answered as "not spent".
   */
  verify(token: string): Promise<MfaPendingTokenClaims | undefined>;

  /**
   * Spends the token immediately, so a second presentation of the same `token` string stops
   * verifying (STORY-013-03, acceptance 2, "инвалидируется немедленно"; acceptance 5, the same
   * mechanism voids a token whose owner exhausts five failed second-factor attempts — the failed-
   * attempt counter is a different subsystem, but it ends here the same way a correct verification
   * does).
   *
   * Takes the claims a prior `verify()` already produced rather than the raw token, because the
   * caller already has them and because sizing the denylist entry needs `expiresAt` — recomputing
   * both from the token string a second time would be a second, redundant verification.
   */
  revoke(claims: Pick<MfaPendingTokenClaims, 'jti' | 'expiresAt'>): Promise<void>;
}
