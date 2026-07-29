/**
 * Refresh-token families, inside the tenant scope.
 *
 * Like every repository here, no method takes a transaction and no method takes an
 * `organizationId`: both come from the scope `UnitOfWorkPort` opened (rules/tenancy-rls.mdc, 9).
 * Everything below therefore runs under the policy, which is what makes "somebody else's session"
 * unreachable rather than merely unasked-for.
 */

/** The reason a session stopped being valid — the `session_revoked_reason` labels of the schema. */
export type SessionRevokedReason =
  'ROTATED' | 'REUSE_DETECTED' | 'LOGOUT' | 'REVOKED_BY_USER' | 'PASSWORD_CHANGED' | 'OFFBOARDING';

export interface SessionDraft {
  readonly userId: string;
  /** The device. A rotation keeps it; a fresh sign-in starts a new one. */
  readonly familyId: string;
  /** The row this one replaces, so an incident can be reconstructed. `null` on a first sign-in. */
  readonly rotatedFromId: string | null;
  readonly refreshTokenHash: Uint8Array;
  readonly userAgent: string;
  readonly ipHash: string;
  /** Already masked by `domain/identity/mask-ip-address.util.ts`; the full address is never here. */
  readonly ipMasked: string;
  readonly expiresAt: Date;
}

export interface CreatedSession {
  readonly id: string;
  readonly createdAt: Date;
}

/** One live session, as `GET /auth/sessions` renders it — one entry per family. */
export interface ActiveSession {
  readonly id: string;
  readonly familyId: string;
  /** When the *family* started: the oldest row, not this one, which is as old as the last rotation. */
  readonly startedAt: Date;
  /** The last rotation — the `createdAt` of the live row (a rotation creates the row). */
  readonly lastUsedAt: Date;
  readonly expiresAt: Date;
  readonly userAgent: string;
  readonly ipMasked: string;
}

/**
 * What an authenticated request needs to know about the session its token names, in one read.
 *
 * `permissionsVersion` comes from the joined `users` row rather than from a second query: the check
 * "is the token's `pv` still current" happens on every request, and two round trips per request is
 * the difference between a guard and a cost.
 */
export interface SessionAuthContext {
  readonly sessionId: string;
  readonly userId: string;
  readonly familyId: string;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date;
  readonly userStatus: string;
  readonly permissionsVersion: number;
}

export interface SessionOwnerRecord {
  readonly id: string;
  readonly userId: string;
  readonly familyId: string;
}

export interface SessionRepositoryPort {
  /**
   * Writes the row, or answers `null` when `refreshTokenHash` is already taken.
   *
   * `null` rather than a thrown conflict, because the caller's response to it is to mint another
   * token and try again *inside the same transaction* — and a unique violation would have aborted
   * that transaction. The digest is thirty-two CSPRNG bytes, so this is a theoretical branch; it
   * exists because `uq_sessions_refresh_hash` is global, and an error code escaping from it would
   * answer "some organization already holds this value".
   */
  create(draft: SessionDraft): Promise<CreatedSession | null>;

  /**
   * Spends the presented refresh token, atomically.
   *
   * `UPDATE ... WHERE id = $1 AND revoked_at IS NULL RETURNING id` — one statement, so two requests
   * arriving with the same token cannot both succeed: the loser updates zero rows and gets `false`.
   * A read-then-write would let both pass under READ COMMITTED and mint two live sessions from one
   * token, which is the failure reuse detection exists to notice.
   */
  markRotated(sessionId: string, at: Date): Promise<boolean>;

  /** Revokes one row; `false` when it was already revoked. */
  revoke(sessionId: string, reason: SessionRevokedReason, at: Date): Promise<boolean>;

  /**
   * Revokes every live row of one family in a single indexed `UPDATE`.
   *
   * One statement and not a walk of `rotatedFromId`: the chain can be thirty days long, and the
   * moment this runs is the moment a stolen token is being used.
   */
  revokeFamily(familyId: string, reason: SessionRevokedReason, at: Date): Promise<number>;

  /**
   * Revokes every live session of the user, keeping none. Returns the number of families closed.
   *
   * Separate from `revokeOtherFamilies` with an id that matches nothing, because that construction
   * makes "close everything" depend on a value being *absent* from the table — and the day somebody
   * passes a real family by mistake, the statement quietly keeps a session alive. A method whose
   * signature has nowhere to put an exception cannot be called with the wrong one.
   *
   * Used by the password reset: whoever is recovering access is usually doing so because somebody
   * else has it too, so no device is trusted, including the one asking.
   */
  revokeAllFamilies(userId: string, reason: SessionRevokedReason, at: Date): Promise<number>;

  /** Revokes every live session of the user except the given family. Returns the number of families. */
  revokeOtherFamilies(
    userId: string,
    keepFamilyId: string,
    reason: SessionRevokedReason,
    at: Date,
  ): Promise<number>;

  /** The row as it is, revoked or not, or `null` when this organization has no such row. */
  findOwner(sessionId: string): Promise<SessionOwnerRecord | null>;

  findAuthContext(sessionId: string): Promise<SessionAuthContext | null>;

  /** Live sessions of one person, newest rotation first, one entry per family. */
  listActive(userId: string, now: Date): Promise<readonly ActiveSession[]>;
}
