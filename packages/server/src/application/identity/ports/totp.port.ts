/** A base32 TOTP secret and the `otpauth://` URI a client renders into a QR code. */
export interface GeneratedTotpSecret {
  /** Base32, RFC 4648 alphabet, no padding — what `otplib` both mints and reads back. */
  readonly base32Secret: string;
  /**
   * `otpauth://totp/BadCRM:{email}?secret=…&issuer=BadCRM&algorithm=SHA1&digits=6&period=30`, ready
   * to encode into a QR code and to show as manual-entry text (STORY-013-01, acceptance 1 and 10).
   */
  readonly uri: string;
}

/**
 * Whether a code was accepted, and the step it was accepted *at* — the piece an equality check
 * cannot answer on its own.
 *
 * `counter` is what makes replay protection possible without trusting the client's clock: the server
 * remembers the counter a code was last accepted at (`totp_last_counter`) and refuses to accept the
 * same or an earlier one again, which is a property of the *step*, not of the six digits — two
 * different steps inside a busy minute can legitimately produce the same digits by coincidence, and a
 * check keyed on the digits alone would refuse the second one for the wrong reason.
 *
 * **`replayed` on the refusal branch says *why*, distinctly from "wrong digits".** The digits can be
 * exactly right and still be refused, when the step they decode to is at or before `sinceCounter` —
 * that is a *different* fact than "these six digits never matched this secret at any accepted step",
 * and `ConfirmTotpUseCase` needs to tell them apart to raise `TotpCodeReplayedError` instead of
 * `InvalidTotpCodeError` (STORY-013-01, acceptance 6).
 */
export type TotpVerification =
  | { readonly accepted: true; readonly counter: number }
  | { readonly accepted: false; readonly replayed: boolean };

/**
 * TOTP as RFC 6238 defines it, with the parameters this installation fixes: SHA-1, six digits, a
 * thirty-second step.
 *
 * SHA-1 rather than SHA-256, deliberately: it is what every authenticator app on a phone actually
 * implements, and 2FA that a person's chosen app cannot compute is 2FA nobody can turn on. The
 * primitive here is a keyed one-time code, not a signature — SHA-1's weakness is collision
 * resistance, which this construction does not lean on.
 *
 * A port rather than a direct `otplib` call from the use-cases, for the same reason `PasswordHasherPort`
 * exists: the algorithm is an infrastructure decision, and a use-case that imported `otplib` directly
 * could not be unit-tested without it.
 */
export interface TotpPort {
  /** A fresh secret with at least 160 bits of entropy (STORY-013-01, acceptance 1), and its URI. */
  generateSecret(email: string): GeneratedTotpSecret;

  /**
   * Checks `code` against `base32Secret` at `at`, allowing a drift of **one step either side**
   * (±30 seconds — `TOTP_DRIFT_WINDOW_STEPS` below documents the choice and its bound).
   *
   * `sinceCounter` is the last counter this account had already accepted, or `null` for a first use.
   * A step at or before it is refused as replayed even when the digits are otherwise correct — the
   * adapter computes the candidate counter and compares it itself, so the anti-replay rule lives in
   * one place rather than being re-derived by every caller from a counter it would otherwise have to
   * extract on its own.
   */
  verify(input: {
    readonly base32Secret: string;
    readonly code: string;
    readonly at: Date;
    readonly sinceCounter: number | null;
  }): TotpVerification;
}

/**
 * The accepted clock drift, in 30-second steps either side of the server's own time — **one**, i.e.
 * ±30 seconds, chosen deliberately rather than left at a library default.
 *
 * STORY-013-01, acceptance 5, fixes both ends of this trade-off with concrete numbers: a client clock
 * 25 seconds slow is accepted, one 90 seconds slow is refused. One step either way covers the first
 * without approaching the second — an unsynchronized phone clock is very rarely more than a few
 * seconds off in practice (NTP drift on a modern OS), so ±30 seconds already has margin to spare for
 * that case. At ±1 step the server accepts **three** steps total (t−1, t, t+1) — one code per step,
 * so three valid six-digit codes at any moment. Widening to ±2 steps would still refuse the 90-second
 * example, but it would also widen the accepted set to **five** steps (t−2 … t+2) — ×1.67, not
 * triple, though still a real widening of the guessable set an attacker holding a partial guess can
 * try inside one rate-limited window (`docs/security/threat-model.md`, T-IAM-04) — for a benefit
 * (tolerating clocks more than half a minute off) this product does not need to buy. The boundary
 * itself is pinned by `otplib-totp.adapter.spec.ts`, which asserts 25 s accepted and 90 s refused
 * against RFC 6238 test vectors rather than against this comment.
 */
export const TOTP_DRIFT_WINDOW_STEPS = 1;

/** Seconds per TOTP step, RFC 6238's own default and the one every authenticator app assumes. */
export const TOTP_STEP_SECONDS = 30;

/** Digits per code — six, the width every authenticator app renders. */
export const TOTP_CODE_DIGITS = 6;
