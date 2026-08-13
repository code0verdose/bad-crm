import { type RateLimitPolicy } from '@/application/platform/ports/rate-limit.port.js';

/** How a repeated lock-out grows. Absent means "the same block every time". */
export interface RateLimitEscalation {
  /** Each further lock-out of the same subject multiplies the block by this. */
  readonly factor: number;
  /** The ceiling. A lock-out that grows without one turns a nuisance into a denial of service. */
  readonly maxBlockSeconds: number;
  /** How long a lock-out is remembered. A successful sign-in forgets it earlier. */
  readonly memorySeconds: number;
}

export interface RateLimitPolicyDefinition {
  /** Attempts granted per window. */
  readonly points: number;
  /** Length of the window, **in seconds** — the unit `rate-limiter-flexible` expects. */
  readonly windowSeconds: number;
  /** How long the subject stays refused once the window is exhausted. */
  readonly blockSeconds: number;
  readonly escalation?: RateLimitEscalation;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * The table of `docs/architecture/stack.md` → «Rate limiting», in one place.
 *
 * Only `auth_attempt` escalates. The others guard capacity — a client that trips the 300/minute
 * budget is a loop to be slowed, not an attacker to be locked out, and doubling its penalty would
 * punish the retry storm that the first refusal already caused. Guessing a password is the one case
 * where a repeat is evidence rather than noise, so it is the one case where the cost of the next
 * attempt goes up (STORY-006-07: "the delay grows exponentially and does not restart on every new
 * attempt").
 *
 * The cap is an hour on purpose. The subject of `auth_attempt` is a **pair**, so a lock-out costs
 * an attacker one address and the legitimate owner of the account at most an hour — but a cap of a
 * day would hand anybody who can reach the login form a way to keep a colleague out until tomorrow.
 * An hour is long enough that guessing at scale is pointless and short enough that a locked-out
 * person can wait it out instead of filing a ticket.
 */
export const RATE_LIMIT_POLICY: Readonly<Record<RateLimitPolicy, RateLimitPolicyDefinition>> = {
  auth_attempt: {
    points: 5,
    windowSeconds: 15 * MINUTE,
    blockSeconds: 15 * MINUTE,
    escalation: { factor: 2, maxBlockSeconds: 1 * HOUR, memorySeconds: 24 * HOUR },
  },
  organization_registration: {
    points: 3,
    windowSeconds: 1 * HOUR,
    blockSeconds: 1 * HOUR,
  },
  api_request: {
    points: 300,
    windowSeconds: 1 * MINUTE,
    blockSeconds: 1 * MINUTE,
  },
  heavy_operation: {
    points: 10,
    windowSeconds: 1 * MINUTE,
    blockSeconds: 1 * MINUTE,
  },
  /**
   * Ten a minute, and no escalation. A tab in a render loop is a defect to be told about once, not
   * an attacker: the first refusals already stop the flood, and locking the reporter out for longer
   * would hide the *next*, different failure behind the one already known.
   */
  client_error_report: {
    points: 10,
    windowSeconds: 1 * MINUTE,
    blockSeconds: 1 * MINUTE,
  },
  /**
   * Twenty in ten minutes: onboarding a whole team on a Monday morning fits, and a script that
   * turns one account into a mailing list does not.
   *
   * No escalation, and the reason is the subject. The counter is keyed on the inviter, so the
   * subject of a lock-out is a colleague who is authenticated and known — an administrator filling
   * a spreadsheet, not somebody guessing. Doubling their block would answer a mistake by making the
   * next hour of their work impossible, and the ten-minute window already costs an abuser far more
   * than it costs them.
   */
  invitation_create: {
    points: 20,
    windowSeconds: 10 * MINUTE,
    blockSeconds: 10 * MINUTE,
  },
  /**
   * Ten in fifteen minutes, and no escalation.
   *
   * The subject is an address, not an account, so a lock-out that grew would eventually punish an
   * office behind one NAT for a colleague who mistyped the link twice. Ten is generous for somebody
   * following a link from their mail and uneconomic for somebody walking a token space of 2^256.
   */
  invitation_accept: {
    points: 10,
    windowSeconds: 15 * MINUTE,
    blockSeconds: 15 * MINUTE,
  },
  /**
   * Drafting (`POST /auth/2fa/setup`) and confirming (`POST /auth/2fa/confirm`) a TOTP secret —
   * one shared budget for the whole enrolment flow, keyed on the caller. Escalates like
   * `auth_attempt`, for the identical reason: a repeated refusal here is evidence of guessing rather
   * than noise, and STORY-013-01 acceptance 4 asks for "экспоненциальной задержкой" by name.
   */
  mfa_setup_attempt: {
    points: 5,
    windowSeconds: 15 * MINUTE,
    blockSeconds: 15 * MINUTE,
    escalation: { factor: 2, maxBlockSeconds: 1 * HOUR, memorySeconds: 24 * HOUR },
  },
  /**
   * Reauthenticating before a recovery-code regeneration or a self-service 2FA disable — one shared
   * budget for both (`rate-limit.port.ts` explains why). No escalation: the subject is an
   * authenticated account holder, not an anonymous guesser, and the fifteen-minute window is already
   * the cost `rules/security.mdc` rule 11 asks for on a sensitive path.
   */
  mfa_reauth_attempt: {
    points: 5,
    windowSeconds: 15 * MINUTE,
    blockSeconds: 15 * MINUTE,
  },
  /**
   * Guessing a TOTP code at `POST /auth/2fa/verify`, counted against the `mfaToken` itself
   * (`rate-limit.port.ts` works through why `jti` and not `userId`). Five guesses, and the window
   * matches the token's own life: STORY-013-03 acceptance 1 gives `mfaToken` a five-minute TTL, and
   * a window longer than that would guard a `jti` the token store has already forgotten. No
   * escalation — a `jti` this policy has not exhausted within its own five minutes is never
   * presented again either way, so a growing block would never have a second occurrence to grow on.
   */
  mfa_verify_attempt: {
    points: 5,
    windowSeconds: 5 * MINUTE,
    blockSeconds: 5 * MINUTE,
  },
  /**
   * The account-scoped half of the same step, which is the one that actually bounds guessing —
   * fifteen minutes, because it has to outlive the five-minute token whose rotation it exists to
   * survive. See the policy's own entry in `rate-limit.port.ts` for why the `jti` budget alone is
   * not a limit.
   */
  mfa_verify_account_attempt: {
    points: 5,
    windowSeconds: 15 * MINUTE,
    blockSeconds: 15 * MINUTE,
  },
  /**
   * Presenting a recovery code during the second-factor step. STORY-013-02 acceptance 10 states the
   * number directly: five attempts, fifteen minutes.
   */
  mfa_recovery_consume_attempt: {
    points: 5,
    windowSeconds: 15 * MINUTE,
    blockSeconds: 15 * MINUTE,
  },
  /**
   * An administrator resetting somebody else's 2FA (`user:reset_mfa`). No escalation, for the same
   * reason as `mfa_reauth_attempt` and `invitation_create`: the subject of a lock-out here is a known,
   * authenticated administrator, not an anonymous guesser.
   */
  mfa_admin_reset_attempt: {
    points: 5,
    windowSeconds: 15 * MINUTE,
    blockSeconds: 15 * MINUTE,
  },
};
