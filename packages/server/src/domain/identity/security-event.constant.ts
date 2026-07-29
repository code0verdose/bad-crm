/**
 * The closed catalog of security events this application records.
 *
 * **The name is a field, never the sentence a log line happens to carry.** An event that can only
 * be found by matching a substring of `msg` is an event nobody can build an alert on: the wording is
 * prose, prose gets improved, and the alert that depended on it goes quiet without failing. So the
 * detection is written as `logger.warn({ event: SECURITY_EVENTS.… }, '<readable sentence>')`, and
 * everything downstream — a log query, an alert rule, and the `AuditLog` writer and notification
 * mail that `rules/security.mdc` rule 8 also asks for — selects on `event`.
 *
 * Closed, and for the same reason `RATE_LIMIT_POLICIES` is: a name invented at a call site is a
 * name no dashboard knows, and a typo would open a second, silent event stream beside the real one.
 *
 * It lives in `domain` because what an event *is* does not depend on where it is written down. The
 * use-case names it; the adapter that eventually persists it names it too.
 */
export const SECURITY_EVENTS = {
  /**
   * A credential was presented at `POST /auth/login` and refused.
   *
   * The one event of this catalog that is expected to be *frequent*, and the reason it exists: the
   * error handler's `request rejected` carries a code and a status and no subject, so a run of them
   * cannot be told from a run of ordinary typos. This line carries the masked source, which is what
   * separates "one address, ten thousand attempts" from "ten thousand people mistyped a password".
   *
   * The `outcome` field says *why* — a wrong credential, a suspended account, a spent budget. That
   * distinction exists in the log and nowhere else: the answer to the caller is deliberately one
   * refusal (`login.use-case.ts`), and moving the reason into the response would make it an
   * enumeration oracle.
   */
  signInFailed: 'sign_in_failed',
  /**
   * A credential verified. `outcome` separates a session that was issued from the branch that
   * stopped at the organization picker — both are successful authentications, and only the first
   * has a `sessionId` to name.
   */
  signInSucceeded: 'sign_in_succeeded',
  /**
   * A session family was closed on purpose: signing out, closing one device from
   * `/settings/security`, or closing every other device. `reason` is the `session_revoked_reason`
   * that was written to the rows, so the log and the table say the same word.
   *
   * Not written for a rotation. A rotation revokes the previous row every fifteen minutes by
   * design, and an event that fires ninety-six times a day per device is an event nobody reads.
   */
  sessionsRevoked: 'sessions_revoked',
  /**
   * A refresh token was presented after it had already been spent, outside the rotation race
   * window — the signal STORY-006-03 revokes the whole family on.
   */
  refreshReuseDetected: 'refresh_reuse_detected',
  /**
   * The account holder changed their own password. `revokedFamilies` says how many other devices
   * were closed by it, which is the number that makes the line worth reading: a change that closed
   * four sessions is somebody taking an account back.
   */
  passwordChanged: 'password_changed',
  /**
   * A change was attempted and refused. `outcome` separates a wrong current password from a spent
   * budget — the same split as `sign_in_failed`, and for the same reason: the answer to the caller
   * deliberately carries neither.
   */
  passwordChangeFailed: 'password_change_failed',
  /**
   * Somebody asked for a reset link. Written for **every** request, including the ones for an
   * address nobody has — `accounts: 0` is the interesting case, and a line written only on the
   * successful branch would turn the log into the enumeration oracle the 202 refuses to be.
   *
   * The address never appears in it, masked or otherwise; the source network does
   * (`rules/observability.mdc`).
   */
  passwordResetRequested: 'password_reset_requested',
  /** A reset token was spent: the password was set and every session of the account was closed. */
  passwordResetCompleted: 'password_reset_completed',
  /**
   * A reset token was presented and refused — unknown, already spent or expired. One event for all
   * three, because the *answer* is one and a log field that separated them would be the place the
   * distinction leaks back out to whoever reads a dashboard over somebody's shoulder.
   */
  passwordResetRefused: 'password_reset_refused',
  /**
   * A password write matched no row — the account was soft-deleted or moved between the read that
   * found it and the `UPDATE` that was about to replace its digest.
   *
   * It has its own name because it is the one outcome of these two operations that is neither a
   * success nor a refusal anybody asked for: the caller is told the operation did not go through,
   * and what an operator needs to know is that a *write* went missing, not that a credential was
   * wrong. Unreachable in practice — the window is the few milliseconds inside one transaction —
   * which is precisely why it must be loud when it happens rather than counted as one more refusal
   * in a stream of them.
   */
  passwordNotWritten: 'password_not_written',
} as const;

export type SecurityEvent = (typeof SECURITY_EVENTS)[keyof typeof SECURITY_EVENTS];
