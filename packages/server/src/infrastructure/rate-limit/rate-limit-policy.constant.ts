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
};
