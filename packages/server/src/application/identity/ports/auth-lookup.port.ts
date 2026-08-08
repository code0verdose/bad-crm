/**
 * The three reads that happen **before** a tenant is known.
 *
 * Authentication has a chicken-and-egg problem that row-level security cannot solve on its own:
 * reading `users` needs `app.organization_id`, and learning `app.organization_id` needs to read
 * `users`. `docs/security/rls-design.md` («Особые пути», path 1) answers it with a narrow,
 * privileged surface rather than with a general escape hatch — a handful of `SECURITY DEFINER`
 * functions owned by `app_auth`, each with a fixed signature, each returning only the columns the
 * decision needs, executable by nobody else.
 *
 * This port is that surface, and its size is the point: three methods, all reads, none of them
 * taking a predicate the caller composes. Everything after the organization is known goes back
 * through `withTenant` and ordinary repositories.
 */

/** What the login path needs about an account, and nothing more. */
export interface AuthUserRecord {
  readonly userId: string;
  readonly email: string;
  readonly locale: string;
  readonly timezone: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  /** The argon2id digest. It leaves this boundary only into `PasswordHasherPort.verify`. */
  readonly passwordHash: string;
  /** `ACTIVE` | `SUSPENDED` | `INVITED`, as the column spells it. */
  readonly status: string;
  readonly permissionsVersion: number;
}

/** What the refresh path needs about a session, addressed by the digest of the presented token. */
export interface AuthSessionRecord {
  readonly sessionId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly familyId: string;
  readonly revokedAt: Date | null;
  /** `null` while the session is live; a `session_revoked_reason` label once it is not. */
  readonly revokedReason: string | null;
  readonly expiresAt: Date;
}

/**
 * Where a reset token lives — and nothing about whether it is still usable.
 *
 * The three columns that answer "which tenant do I open" and no more. `expires_at` and `used_at` are
 * deliberately absent: deciding usability here would mean deciding it with a read, and the decision
 * has to be the conditional `UPDATE` that spends the row, or two clicks on one link both pass
 * (`password-reset-token.port.ts`). Leaving them out also means this privileged surface cannot be
 * used to ask "did somebody complete a reset", which is the one thing the single answer of
 * `password_reset_token_invalid` is designed to hide.
 */
export interface AuthPasswordResetRecord {
  readonly tokenId: string;
  readonly organizationId: string;
  readonly userId: string;
}

/**
 * An invitation, resolved to its organization by the digest of its token.
 *
 * Two ids and nothing else — deliberately not `acceptedAt` or `expiresAt`. Returning them would
 * invite the caller to decide usability from a *read*, and two clicks on one link would then both
 * pass that decision under READ COMMITTED and create two accounts. Usability is decided by the
 * conditional `UPDATE` that spends the row, under `app_user`, once this has said which organization
 * it belongs to.
 */
export interface AuthInvitationRecord {
  readonly invitationId: string;
  readonly organizationId: string;
}

export interface AuthLookupPort {
  /**
   * Every account that can sign in with this address, across the organizations of the installation.
   *
   * More than one row is normal on a self-hosted install where somebody belongs to two
   * organizations. The list never leaves the server as such: the caller verifies the password
   * against each candidate first, and only the ones that verified are described to the client
   * (`docs/api/openapi.yaml`, `OrganizationSelectionRequired`).
   */
  findUsersByEmail(email: string): Promise<readonly AuthUserRecord[]>;

  /**
   * The account of one address inside one organization — the pair `uq_users_org_email` is unique on.
   *
   * The preferred path, because it is not an oracle for "in which organizations does this address
   * have an account": the caller has to name the organization, and naming one that does not exist
   * is answered exactly like a wrong password.
   */
  findUserByEmailAndSlug(email: string, organizationSlug: string): Promise<AuthUserRecord | null>;

  /** One session, by the digest of its refresh token. Read-only: rotation happens under `app_user`. */
  findSessionByRefreshHash(refreshTokenHash: Uint8Array): Promise<AuthSessionRecord | null>;

  /**
   * The fourth org-less read: a reset link is opened by somebody who cannot sign in, so the only
   * thing the request carries is the token — which is why `uq_password_reset_tokens_hash` is global.
   *
   * Read-only, like the other three. Spending the token happens under `app_user` inside
   * `withTenant`, once this has said which organization that is.
   */
  findPasswordResetToken(tokenHash: Uint8Array): Promise<AuthPasswordResetRecord | null>;

  /**
   * The fifth org-less read, and the one whose caller has no account **at all**: `/invite/<token>`
   * is opened by somebody the installation has never seen, so the request carries a digest and
   * nothing else.
   *
   * `null` covers unknown, revoked and «the organization was deactivated» — the resolver joins
   * `organizations ON deleted_at IS NULL`, so all three answer identically (`T-IAM-03`). Accepted
   * and expired are indistinguishable one step later, in the conditional write.
   */
  findInvitation(tokenHash: Uint8Array): Promise<AuthInvitationRecord | null>;
}
