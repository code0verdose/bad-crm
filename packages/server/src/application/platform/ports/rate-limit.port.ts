/**
 * The limits this installation enforces, as named in `docs/architecture/stack.md` → «Rate limiting».
 *
 * A closed list rather than free-form strings: a limit invented at a call site is a limit nobody
 * reviewed, and a typo would silently open a private counter with a fresh budget instead of
 * consuming the shared one.
 */
export const RATE_LIMIT_POLICIES = [
  /** Sign-in, password reset and 2FA. Keyed on IP **and** email; 5 attempts / 15 minutes. */
  'auth_attempt',
  /** Self-service creation of an organization. Keyed on IP; 3 / hour (threat model T-TENANT-07). */
  'organization_registration',
  /** The ambient API budget: 300 / minute per authenticated user, per address when anonymous. */
  'api_request',
  /** Export, AI and search. Keyed on the user; 10 / minute. */
  'heavy_operation',
  /**
   * Browser failure reports. Keyed on the user when there is a session and on the address otherwise;
   * 10 / minute.
   *
   * Its own policy rather than a share of `api_request`, because the failure mode is specific: a
   * render loop reports the same error on every frame, and a budget of 300 would let one broken tab
   * write three hundred lines a minute into the log of an installation that has no idea why.
   */
  'client_error_report',
  /**
   * Creating invitations. Keyed on the inviter; 20 / 10 minutes.
   *
   * Its own policy rather than a share of `api_request`, because the cost is not ours: every
   * invitation is a message our relay sends to an address the caller chose, and a budget of three
   * hundred a minute would make an authenticated account a mail cannon pointed at anybody. Keyed on
   * the inviter for the same reason it is not keyed on the recipient — the recipient is the part the
   * caller varies (`docs/security/threat-model.md`, `T-IAM-10`).
   */
  'invitation_create',
  /**
   * Presenting an invitation link. Keyed on the address; 10 / 15 minutes.
   *
   * The caller has no account and no session — the token **is** the credential — so the address is
   * the only subject there is. Keying it on anything derived from the token would give every guess a
   * fresh budget, which is not a limit at all (the same reasoning as `confirm-password-reset`).
   */
  'invitation_accept',
  /**
   * Drafting a TOTP secret at `POST /auth/2fa/setup` and confirming it at `POST /auth/2fa/confirm` —
   * one shared budget for the whole enrolment flow. Keyed on the caller, who is already authenticated
   * at this point; 5 / 15 minutes, escalating — the same budget `auth_attempt` gives guessing a
   * password, because a six-digit code is guessable in the same order of magnitude
   * (`docs/security/threat-model.md`, T-IAM-04; STORY-013-01, acceptance 4).
   */
  'mfa_setup_attempt',
  /**
   * Reauthenticating with the current password and a live TOTP code before
   * `POST /auth/2fa/recovery-codes/regenerate` is allowed to run. Keyed on the caller; 5 / 15 minutes.
   */
  'mfa_reauth_attempt',
  /**
   * Presenting a recovery code — the atomic building block `ConsumeRecoveryCodeUseCase` exercises
   * today and the budget `POST /auth/2fa/verify` will spend from once STORY-013-03 wires the
   * second-factor sign-in step to it. Keyed on `userId` alone (`RateLimitSubjects.mfa_recovery_consume_attempt`
   * is `UserSubject`, rendered by `rateLimitKeyOf` as `user=${userId}` — there is no separate
   * "pending sign-in" subject anywhere in this codebase), not on IP and email the way `auth_attempt`
   * is: there is no email at this point in the flow, only a userId that `auth_attempt` already
   * bounded reaching. 5 / 15 minutes (STORY-013-02, acceptance 10).
   */
  'mfa_recovery_consume_attempt',
] as const;

export type RateLimitPolicy = (typeof RATE_LIMIT_POLICIES)[number];

/**
 * The pair a sign-in attempt is counted against.
 *
 * **Both halves, always.** Counting on the address alone punishes an office, a university or a
 * mobile carrier for one person behind the NAT, and it is the reason "rate limiting broke our
 * customer" stories exist. Counting on the address alone *also* fails the other way: an attacker
 * with a list of addresses spends the whole budget of a shared exit node and locks out everybody
 * else while barely slowing down. Counting on the email alone is worse still — the attacker simply
 * moves to the next proxy, and meanwhile anybody can lock a known colleague out of their account by
 * failing five logins for them. The pair costs an attacker a fresh address for every account they
 * want to keep guessing at, which is the property that makes the guessing uneconomic.
 *
 * `ipAddress` may be absent: a request over a unix socket has no peer address, and
 * `X-Forwarded-For` is written by whatever sits in front. The adapter maps every unreadable address
 * onto one stated bucket rather than onto a fresh counter per malformed value — the strict
 * direction, because the alternative is a limiter switched off by an unparsable header.
 */
export interface IpEmailSubject {
  readonly ipAddress: string | undefined;
  readonly email: string;
}

/** An anonymous caller identified only by where the request came from. */
export interface IpSubject {
  readonly ipAddress: string | undefined;
}

/** A signed-in caller. */
export interface UserSubject {
  readonly userId: string;
}

/** The ambient budget: the user when there is one, the address otherwise. */
export interface ActorSubject {
  readonly userId: string | undefined;
  readonly ipAddress: string | undefined;
}

/**
 * Which subject each policy is counted against — the pairing is part of the contract.
 *
 * Expressed as a type map so that `consume('auth_attempt', { ipAddress })` does not compile. The
 * requirement "the key is a pair" is otherwise a sentence in a document, and a sentence in a
 * document does not survive the first controller written in a hurry.
 */
export interface RateLimitSubjects {
  readonly auth_attempt: IpEmailSubject;
  readonly organization_registration: IpSubject;
  readonly api_request: ActorSubject;
  readonly heavy_operation: UserSubject;
  readonly client_error_report: ActorSubject;
  readonly invitation_create: UserSubject;
  readonly invitation_accept: IpSubject;
  readonly mfa_setup_attempt: UserSubject;
  readonly mfa_reauth_attempt: UserSubject;
  readonly mfa_recovery_consume_attempt: UserSubject;
}

/**
 * The answer, which is never "the limiter could not tell".
 *
 * `retryAfterSeconds` is the time actually left on the counter, so the caller can put it in
 * `Retry-After` (`RateLimitedError` in `domain/shared/errors/app.errors.ts` carries it to the
 * header). A constant there would tell every client to come back at the same moment, which is how a
 * limiter turns a burst into a synchronised burst.
 */
export type RateLimitDecision =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * The distributed attempt counter.
 *
 * **Failure to reach the store is never `allowed: true`.** `consume` raises
 * `ServiceUnavailableError` — answered `503 service_unavailable`, which `docs/api/openapi.yaml`
 * declares on `login` and `refresh` for exactly this case. A limiter that starts admitting
 * everybody when its store is down is absent precisely when it is needed: making Redis unreachable
 * would become the cheapest way to switch the brute-force defence off (STORY-006-07,
 * `docs/security/threat-model.md` T-IAM-03, T-IAM-08). Refusing is the direction that fails safe;
 * an installation whose Redis is down is broken either way, and this way it is broken loudly.
 *
 * Callers consume **before** doing the expensive work — verifying a password runs Argon2id over
 * 19 MiB, and a limiter checked afterwards is a memory-exhaustion vector rather than a defence
 * (T-IAM-08).
 */
export interface RateLimitPort {
  /**
   * Spends one point of `policy` for `subject`.
   *
   * @throws ServiceUnavailableError when the counter store cannot be reached.
   */
  consume<P extends RateLimitPolicy>(
    policy: P,
    subject: RateLimitSubjects[P],
  ): Promise<RateLimitDecision>;

  /**
   * Forgets the failures of `subject` — called after the credential was accepted.
   *
   * Deliberately does **not** raise when the store is unreachable: by the time this runs the
   * caller has already authenticated somebody, and turning a successful sign-in into a 503 would
   * be a worse answer than a counter that expires on its own a few minutes later.
   */
  reset<P extends RateLimitPolicy>(policy: P, subject: RateLimitSubjects[P]): Promise<void>;
}
