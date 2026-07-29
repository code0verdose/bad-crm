/**
 * Password-reset tokens of the organization in the current scope.
 *
 * Like every repository here it takes no transaction and no `organizationId`: both come from the
 * scope `UnitOfWorkPort` opened (`rules/tenancy-rls.mdc`, 9). The read that happens *before* a
 * tenant is known — resolving a token presented by somebody who is by definition not signed in —
 * is deliberately not here and could not be; it lives on the narrow `app_auth` surface behind
 * `AuthLookupPort`, exactly as the session lookup of the refresh path does.
 */

export interface PasswordResetTokenDraft {
  readonly userId: string;
  /** SHA-256 of the value in the mail. The value itself never crosses this boundary. */
  readonly tokenHash: Uint8Array;
  readonly expiresAt: Date;
  /**
   * The same keyed digest of the source address that a session row carries, or `null` when there
   * was no address to read. The full address is stored nowhere (`data-model.md`, «Про адрес сессии»).
   */
  readonly requestedIpHash: string | null;
}

export interface PasswordResetTokenRepositoryPort {
  /** Writes the row and answers its id. */
  create(draft: PasswordResetTokenDraft): Promise<string>;

  /**
   * Spends the token, atomically, and answers the account it belonged to — or `null`.
   *
   * `UPDATE … SET used_at = $2 WHERE id = $1 AND used_at IS NULL AND expires_at > $2 RETURNING
   * user_id`: **one statement**, so two clicks on the same link cannot both succeed — the loser
   * updates no row and gets `null`. A read-then-write would let both pass under READ COMMITTED and
   * reset the password twice, the second time to whatever the slower request was carrying.
   *
   * Expiry is part of the same predicate rather than a check the caller makes, so "spent" and
   * "expired" are one outcome in the code as well as in the answer — there is no branch left where
   * somebody could tell a caller which of the two it was (`data-model.md` §1).
   */
  consume(tokenId: string, now: Date): Promise<string | null>;

  /**
   * Spends every *other* still-usable token of one account, without resolving any of them.
   *
   * `UPDATE … SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL`, in the same transaction as
   * the password write that calls it. The password is the thing all of these links lead to, so the
   * moment it changes they are all stale — and a link that is stale but still works is the whole
   * finding:
   *
   * > somebody with a few minutes of access to a mailbox asks for a reset and keeps the link. The
   * > owner notices, changes the password and closes the sessions. The link is still good for up to
   * > an hour, and spending it changes the password again and closes the sessions the owner just
   * > opened.
   *
   * The same applies between two resets of the same account, and it is why this belongs to the
   * transaction rather than to a follow-up: a commit that wrote a new digest and left a live token
   * behind has handed the account to whoever holds it.
   *
   * Answers how many rows it closed, which is the number worth a log line — a change that
   * invalidated an outstanding link is a change that happened while somebody was recovering.
   */
  invalidateOutstanding(userId: string, at: Date): Promise<number>;

  /**
   * Removes the rows of one account that can never be spent again — used, or past their hour.
   *
   * Called when a new token is issued, inside the same transaction: a table nobody ever deletes from
   * grows for the lifetime of the installation, and every row in it is a digest of a credential that
   * was mailed to somebody. Deleting them where the next write already is costs one indexed
   * statement and needs no scheduler, which this deployment does not have yet — there is no
   * `outbox_event` table and no BullMQ worker (ADR-0021), so a global sweep has nowhere to run.
   *
   * It is therefore hygiene rather than the security control: what makes a stale token harmless is
   * that `consume` refuses it, and that refusal is reached before anything expensive happens
   * (`confirm-password-reset.use-case.ts`). What this bounds is the size of the table for every
   * account that ever asks again. Accounts that never ask again keep their settled rows until the
   * sweep of the queue epic exists.
   */
  deleteSettled(userId: string, now: Date): Promise<number>;
}
