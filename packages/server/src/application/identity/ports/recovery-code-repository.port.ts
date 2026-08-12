/** One stored recovery-code row, as much of it as a consumer needs to try a guess against it. */
export interface RecoveryCodeCandidate {
  readonly id: string;
  readonly codeHash: string;
}

export interface RecoveryCodeCounts {
  readonly total: number;
  readonly remaining: number;
}

/**
 * `mfa_recovery_codes` of the account in the current tenant scope.
 *
 * Like every repository in this codebase, it takes no `organizationId` and no transaction: both come
 * from the scope `UnitOfWorkPort.withTenant` opened (`rules/tenancy-rls.mdc`, rule 9).
 *
 * **There is no `findByHash`.** Argon2id salts every hash independently, so the same plaintext code
 * produces a different `code_hash` on every insertion — a stored hash cannot be looked up by
 * recomputing one from the presented code the way a SHA-256 digest could. Consuming a code is
 * therefore a **loop over the unused rows**, verifying each candidate's hash in turn
 * (`ConsumeRecoveryCodeUseCase`), which is exactly the shape `LoginUseCase.verifyAll` already uses for
 * argon2id and for the identical reason: it is what keeps the elapsed time independent of *which*
 * code, if any, matched.
 */
export interface RecoveryCodeRepositoryPort {
  /** Writes a fresh batch, inside the caller's transaction. Does not touch any existing row. */
  createMany(userId: string, hashes: readonly string[]): Promise<void>;

  /** Every row of the account that has not been spent yet — the candidate set a consume loop tries. */
  listUnused(userId: string): Promise<readonly RecoveryCodeCandidate[]>;

  /**
   * Spends exactly one row, atomically, and answers whether it actually happened.
   *
   * `UPDATE mfa_recovery_codes SET used_at = $3 WHERE id = $2 AND user_id = $1 AND used_at IS NULL
   * RETURNING id` — one statement, so two requests that both matched the same row by hash comparison
   * (STORY-013-02, acceptance 3) cannot both win: the loser's `UPDATE` matches zero rows and answers
   * `false`. Both requests still each pay one argon2id verification to get here — the cost the loop
   * above already accepts — but at most one of them proceeds past this line.
   *
   * **`userId` is required, not implied by `id` being unique.** `id` on its own already can only ever
   * name one row — the predicate is not there to disambiguate it. It is there because `id` reaches
   * this call by way of `ConsumeRecoveryCodeUseCase.match`, which resolves it from an argon2id
   * comparison over a candidate list rather than from a `WHERE user_id = …` a database enforces on
   * this call itself; a caller that passed the wrong id — a bug reachable without crossing any tenant
   * boundary RLS would catch — would otherwise spend a different account's code inside the very same
   * organization. Read from `current_setting('app.user_id')` instead of taking it as an argument was
   * considered and rejected: nothing sets or reads that key today, and a scope opened without a user
   * (a background job, a future admin action) would make the predicate compare against nothing and
   * silently stop filtering at exactly the callers most likely to pass the wrong id.
   */
  markUsed(userId: string, id: string, now: Date): Promise<boolean>;

  /**
   * Removes every row of the account in one statement, ahead of writing a fresh batch in the same
   * transaction (STORY-013-02, acceptance 7: "**все** старые хеши удаляются в той же транзакции").
   *
   * A `DELETE`, not a mass `used_at` stamp: a spent code and a superseded one answer the same question
   * ("is this code usable") identically, and the table exists to answer exactly that question — there
   * is no screen that distinguishes "used" from "invalidated by a regeneration", and keeping the rows
   * around would only grow the table for every account that ever regenerates.
   */
  deleteAllForUser(userId: string): Promise<number>;

  /** `{ total, remaining }` — the only shape the status endpoint may answer with (STORY-013-02, 2). */
  counts(userId: string): Promise<RecoveryCodeCounts>;
}
