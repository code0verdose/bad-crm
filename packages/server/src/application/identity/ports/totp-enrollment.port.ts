/** The four TOTP columns of `users`, as they stand for one account (`data-model.md`, group 1). */
export interface TotpEnrollmentState {
  /** `v1:<iv>:<tag>:<ciphertext>` — never decrypted here; the use-case decides when that is needed. */
  readonly secretEnc: string;
  readonly enabledAt: Date | null;
  readonly draftExpiresAt: Date | null;
  readonly lastCounter: number | null;
}

/**
 * The `users` columns that carry one account's TOTP enrolment.
 *
 * Not folded into `UserRepositoryPort`: that port loads and saves the account as a whole for the
 * sign-in and password paths, and every one of its callers would otherwise carry four columns of a
 * feature they never touch. This mirrors the split that already exists between `UserRepositoryPort`
 * and `PasswordResetTokenRepositoryPort` — a second, narrow port over the same table for a workflow
 * with its own atomicity rules.
 *
 * **Every write here is a single conditional `UPDATE`, never a read followed by a write.** Two
 * requests racing to confirm the same draft, or a confirm racing a fresh `setup`, must not both
 * succeed — the same reasoning `PasswordResetTokenRepositoryPort.consume` documents at length, applied
 * to enrolment instead of to a reset link.
 */
export interface TotpEnrollmentRepositoryPort {
  /** The four columns, or `null` when the account row itself cannot be found (soft-deleted, gone). */
  find(userId: string): Promise<TotpEnrollmentState | null>;

  /**
   * Writes a fresh draft: `secretEnc` and `draftExpiresAt` and clears any leftover `lastCounter` from
   * an abandoned attempt.
   *
   * `UPDATE users SET totp_secret_enc = $2, totp_draft_expires_at = $3, totp_last_counter = NULL
   * WHERE id = $1 AND totp_enabled_at IS NULL RETURNING id`. **Answers whether the row was actually
   * written** — `false` means 2FA is already enabled on this account (`WITH CHECK` cannot fire twice
   * on the same predicate; the guard is `totp_enabled_at IS NULL`), which is what lets
   * `SetupTotpUseCase` answer `mfa_already_enabled` from the write itself rather than from a read
   * a moment earlier that a concurrent `confirm` could have overtaken.
   */
  beginDraft(userId: string, secretEnc: string, draftExpiresAt: Date): Promise<boolean>;

  /**
   * Turns a live, unexpired draft into an enabled enrolment in one statement, recording the counter
   * the confirming code was accepted at.
   *
   * `UPDATE users SET totp_enabled_at = $2, totp_draft_expires_at = NULL, totp_last_counter = $3
   * WHERE id = $1 AND totp_enabled_at IS NULL AND totp_draft_expires_at > $2 RETURNING id`. `false`
   * covers three states the caller does not need to tell apart: no draft, an already-enabled account,
   * and an expired draft — all three are refused the same way (`invalid_totp_code`), which is why they
   * collapse into one boolean here instead of a discriminated result.
   */
  commitEnrollment(userId: string, counter: number, now: Date): Promise<boolean>;

  /**
   * Advances the anti-replay counter alone, without touching enrolment state — the operation
   * `POST /auth/2fa/verify` will call once STORY-013-03 wires the sign-in step to the same secret.
   *
   * `UPDATE users SET totp_last_counter = $2 WHERE id = $1 AND totp_enabled_at IS NOT NULL AND
   * (totp_last_counter IS NULL OR totp_last_counter < $2) RETURNING id`. `false` is the replay
   * refusal: the presented code decoded to a step at or before one already accepted.
   */
  advanceCounter(userId: string, counter: number): Promise<boolean>;

  /**
   * Discards a draft that will never be confirmed — five wrong codes in a row (STORY-013-01,
   * acceptance 4), so the next attempt has to start from a freshly scanned QR code rather than
   * continuing to guess against the one already exposed to five failures.
   *
   * `UPDATE users SET totp_secret_enc = NULL, totp_draft_expires_at = NULL, totp_last_counter = NULL
   * WHERE id = $1 AND totp_enabled_at IS NULL AND totp_secret_enc IS NOT NULL`. Guarded the same way
   * as every other write here: an account that reached `enabled` between the failure count and this
   * call keeps its secret.
   *
   * **Answers whether a draft was actually there to discard.** `totp_secret_enc IS NOT NULL` is not
   * an optimisation — it is what makes the write idempotent in the caller's favour: the rate limit
   * that gates `ConfirmTotpUseCase` blocks for fifteen minutes, and every request that arrives during
   * the block finds the same exhausted budget and calls this method again. Without the predicate the
   * `UPDATE` matches every one of those requests (the row still satisfies `totp_enabled_at IS NULL`
   * after the first call), and a caller that did not check the return value would write one audit row
   * per blocked request instead of one per actual state change — the return value is what lets it
   * tell "there was a draft, and it is gone now" from "there was nothing left to discard" apart.
   */
  abandonDraft(userId: string): Promise<boolean>;
}
