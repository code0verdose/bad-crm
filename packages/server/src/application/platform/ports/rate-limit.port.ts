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
   * Reauthenticating with the current password and a live TOTP-or-recovery-code proof before
   * `POST /auth/2fa/recovery-codes/regenerate` **or** `POST /auth/2fa/disable` is allowed to run —
   * one shared budget for both, because both ask the identical question of the identical caller
   * ("does whoever holds this session still control the password and the second factor") and a
   * separate counter per route would let an attacker who exhausted one keep guessing on the other.
   * Keyed on the caller; 5 / 15 minutes.
   */
  'mfa_reauth_attempt',
  /**
   * Presenting a TOTP code at `POST /auth/2fa/verify` — the step STORY-013-03 acceptance 5 names
   * directly. Keyed on the `jti` of the `mfaToken` the caller is holding, **not** on `userId`.
   *
   * **Why `userId` is not enough.** Acceptance 5 asks for a specific shape: five wrong codes kill
   * the token outright, and the only way back is paying for a new one — presenting the password
   * again at `/auth/login`. A `userId`-keyed budget cannot deliver that shape, because it does not
   * die with the token that exhausted it. The fifth wrong guess against token A would leave the
   * budget spent for token B too — the one a legitimate re-login just bought with a fresh Argon2id
   * verification — so somebody who fat-fingers a code five times, then correctly re-enters their
   * password exactly as the design asks, would still find `verify` refused for the length of the
   * block. That is the specific failure "reauthenticate for a fresh start" exists to rule out, not
   * a milder version of the same protection. It would also need active maintenance to avoid: unlike
   * `auth_attempt`, which `LoginUseCase` explicitly clears with `reset()` on a successful sign-in,
   * nothing resets a `userId`-keyed verify budget when a fresh `mfaToken` is minted — that reset
   * would have to be wired by hand from the login step into this policy, a second thing to
   * remember and a second thing to get wrong. Keying on `jti` needs no such wiring: a new token is
   * a new key by construction, because it is a different string, the same way a new `Session` gets
   * a clean slate without anyone resetting the old one.
   *
   * **Why `jti` does not hand an attacker a free reset.** A `jti` is not a value a caller picks. It
   * exists only because the server minted a signed `mfaToken`, and the server mints one only after
   * `LoginUseCase` accepts a password — argon2id at the configured cost, spent behind the
   * `auth_attempt` budget on the identical `IpEmailSubject` pair, consulted before that cost is
   * paid (acceptance 9, "the budget comes first"). "Reset the counter" therefore means "pass the
   * password check again", the same cost every other candidate on this path already pays — not a
   * client-controlled value an attacker varies for nothing, the way a header nobody signs would be.
   *
   * 5 attempts, 5 minutes: the same TTL acceptance 1 gives the token itself, because a `jti` this
   * policy has not refused within its own token's life will never be presented again either way —
   * a longer window would guard a counter nothing outlives to reuse.
   */
  'mfa_verify_attempt',
  /**
   * Presenting a recovery code on `POST /auth/2fa/verify`'s recovery path — the atomic building
   * block `ConsumeRecoveryCodeUseCase` implements, and, as of STORY-013-03, the step that actually
   * calls it. Keyed on the pair `RateLimitSubjects.mfa_recovery_consume_attempt` now declares —
   * `IpUserSubject`: the caller's address together with the `userId` the pending `mfaToken` already
   * carries in its `pending:{userId}` subject. Not `userId` alone, and not `email` the way
   * `auth_attempt` is keyed — there is no email at this point in the flow, and the pending sign-in
   * this policy had no way to see before STORY-013-03 is exactly what supplies the `userId` now.
   *
   * The property is `IpEmailSubject`'s "both halves", with `userId` standing in for `email`: an
   * address-only key would let one network burn through the five guesses of every account it tries,
   * one guess per account, for free — and the `userId`-only key this policy shipped with before this
   * story gives a fixed account five guesses no matter how many networks they arrive from, but
   * measures nothing at all about one address working through many accounts. That second gap is the
   * one STORY-013-02's own acceptance 10 recorded as open — "IP-половины нет" — pending this story;
   * closing it here does not add a defence against the distributed case (one address, many
   * accounts) either, only against the single-account case the pair now shares fault for with
   * `auth_attempt` on purpose. `ipAddress` may be absent for the reasons `IpEmailSubject` gives.
   * 5 / 15 minutes (STORY-013-02, acceptance 10).
   */
  'mfa_recovery_consume_attempt',
  /**
   * `POST /users/{userId}/reset-mfa` — the administrative path, not the self-service one above.
   * A budget of its own rather than a share of `mfa_reauth_attempt`, because the two answer different
   * questions of different subjects: `mfa_reauth_attempt` asks the *caller* to re-prove their own
   * password and code, and `user:reset_mfa` skips both proofs by design (STORY-013-04's whole reason
   * to exist is a way back in for somebody who has neither) — there is no reauthentication here to
   * share a counter with. Keyed on the **actor** — the administrator holding the permission, not the
   * account being reset — the same reasoning `invitation_create` is keyed on the inviter rather than
   * the invitee: the subject of a lock-out has to be the account whose choice is being throttled, and
   * an idempotent repeat against an already-disabled target still spends one point, the same way
   * `mfa_reauth_attempt` is spent before its own transaction whether or not the credentials presented
   * turn out to be valid — a caller answers the same before either transaction opens. 5 / 15 minutes,
   * no escalation — an authenticated, known administrator, the same class `mfa_reauth_attempt` and
   * `invitation_create` reason from for leaving escalation out.
   */
  'mfa_admin_reset_attempt',
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

/**
 * The pair a recovery-code presentation is counted against, once a pending sign-in gives it a
 * `userId` to pair with — `IpEmailSubject`'s "both halves" property with `userId` standing in for
 * `email`, for the same reason: neither half alone is a limit an attacker cannot walk around by
 * varying the other (`mfa_recovery_consume_attempt`'s own catalog entry above works through this in
 * full). `ipAddress` may be absent for the reasons `IpEmailSubject` gives.
 *
 * **Not to be confused with `ActorSubject` below, even though a value of one can look exactly like
 * a value of the other.** `{ userId: '01J…', ipAddress: '203.0.113.42' }` is a legal `ActorSubject`
 * *and* a legal `IpUserSubject` — same fields, same runtime shape — and the two are rendered
 * differently on purpose: `ActorSubject` drops the address once a user is known, `IpUserSubject`
 * never drops either half. Nothing about the value itself says which rule applies; only the policy
 * does, which is why `rate-limit-key.util.ts` dispatches on the policy rather than inspecting the
 * subject (see `SUBJECT_RENDERERS` there).
 */
export interface IpUserSubject {
  readonly ipAddress: string | undefined;
  readonly userId: string;
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
 * The intermediate `mfaToken` presented at the second-factor step of sign-in — the credential *at
 * this point*, the way an invitation link's token is the credential for `invitation_accept` above.
 * There is no session and no `userId` an ordinary request would carry; there is only the token, and
 * `jti` is the part of it this subsystem is allowed to see without decoding the JWT itself.
 */
export interface MfaTokenSubject {
  readonly jti: string;
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
  readonly mfa_verify_attempt: MfaTokenSubject;
  readonly mfa_recovery_consume_attempt: IpUserSubject;
  readonly mfa_admin_reset_attempt: UserSubject;
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
