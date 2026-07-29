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
}
