/**
 * The short-lived half of a session: a signed statement the API can check without a database read.
 *
 * Fifteen minutes is not a compromise between convenience and safety, it is the *whole* safety
 * property of the split: an XSS that reaches this token gets those fifteen minutes, while the thirty
 * days live in a cookie no script can read (`docs/api/openapi.yaml`, `bearerAuth`).
 */

/** The claims this product puts in an access token, spelled as the contract publishes them. */
export interface AccessTokenClaims {
  /** `sub` — the user. */
  readonly userId: string;
  /** `org` — the organization the session is scoped to; the tenant of every following statement. */
  readonly organizationId: string;
  /** `sid` — the session row, so a revoked session invalidates its tokens before they expire. */
  readonly sessionId: string;
  /**
   * `pv` — `User.permissionsVersion` as it was when the token was minted.
   *
   * A token whose `pv` is behind the row has stale rights. It is what makes a revoked permission
   * take effect without keeping a list of every issued token (`schema.prisma`, `User`).
   */
  readonly permissionsVersion: number;
  /**
   * `scope` — whether this session may do anything but enrol a second factor and sign out.
   *
   * `false` for an ordinary session, and the claim is then absent from the token entirely. `true`
   * mints `scope: 'mfa_enrollment'`: the organization's policy covers a role this person holds,
   * they have no second factor and their grace period is over, so the session exists only so they
   * can arrange one (STORY-013-05, acceptance 3).
   *
   * **In the token rather than read per request, deliberately.** The alternative — deciding it in a
   * guard — would put the policy read, the role read and the enrolment read on every request of
   * every organization, including the ones that have no policy. Here it costs two statements once
   * per session issue, and the fifteen-minute lifetime is what bounds the staleness: somebody who
   * enrols keeps a scoped token until their next refresh, which is why `ConfirmTotpUseCase`'s
   * response tells the client to refresh.
   */
  readonly mfaEnrollment: boolean;
}

export interface IssuedAccessToken {
  readonly token: string;
  /** Seconds until it expires — the `expiresIn` of the contract, a hint for the client's timer. */
  readonly expiresInSeconds: number;
}

export interface AccessTokenPort {
  issue(claims: AccessTokenClaims): Promise<IssuedAccessToken>;

  /**
   * The claims of a token that verified, or `undefined` for anything else.
   *
   * One answer for a bad signature, an expired token, a missing claim and a token signed with
   * another algorithm: the caller has the same thing to do in every case, and a reason string is a
   * thing that ends up in a response.
   */
  verify(token: string): Promise<AccessTokenClaims | undefined>;
}
