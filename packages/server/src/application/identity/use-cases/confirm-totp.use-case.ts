import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type GenerateRecoveryCodesUseCase } from '@/application/identity/use-cases/generate-recovery-codes.use-case.js';
import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import { type TotpEnrollmentRepositoryPort } from '@/application/identity/ports/totp-enrollment.port.js';
import { type TotpPort } from '@/application/identity/ports/totp.port.js';
import {
  type UserCredentialRecord,
  type UserRepositoryPort,
} from '@/application/identity/ports/user-repository.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type FieldEncryptionPort } from '@/application/platform/ports/field-encryption.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type MailDispatchPort } from '@/application/platform/ports/mail-dispatch.port.js';
import { type RateLimitPort } from '@/application/platform/ports/rate-limit.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { renderMfaChangedMail } from '@/domain/identity/mfa-changed-mail.util.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import {
  InvalidTotpCodeError,
  RateLimitedError,
  ReauthenticationRequiredError,
  ServiceUnavailableError,
  TotpCodeReplayedError,
} from '@/domain/shared/errors/app.errors.js';

export interface ConfirmTotpInput {
  readonly actor: { readonly organizationId: string; readonly userId: string };
  readonly code: string;
  /**
   * Proof that whoever holds this session is also the account owner — see the class docstring,
   * «A session is not the second factor». Never optional: a route that could omit it would be a
   * second, weaker way to reach this use-case.
   */
  readonly currentPassword: string;
  /** The caller's address, for the audit trail — `undefined` off a socket with no peer address. */
  readonly ipAddress: string | undefined;
}

export interface ConfirmTotpResult {
  /** Shown once, in this response, and never again — STORY-013-02, acceptance 1 and 2. */
  readonly recoveryCodes: readonly string[];
}

/** Why a presented code was refused — a closed set, because it is the field an alert selects on. */
type TotpRefusalOutcome = 'no_draft' | 'wrong_code' | 'replayed' | 'race_lost' | 'wrong_password';

/**
 * Proving possession of the drafted secret: `POST /auth/2fa/confirm`.
 *
 * ## A session is not the second factor
 *
 * Enabling 2FA is a privileged change to how the account is protected, and a bearer access token
 * sitting in a compromised browser tab is exactly the credential an attacker would use to make it —
 * pointing the account at a TOTP secret *they* hold turns a session hijack into a durable takeover
 * that a stolen-cookie mitigation cannot undo. So `currentPassword` is required and checked the same
 * way `RegenerateRecoveryCodesUseCase` checks it before a recovery-code regeneration: unconditionally,
 * every time, in the same budget as the TOTP check. Getting the password wrong answers the identical
 * `ReauthenticationRequiredError` a wrong or absent draft answers via `InvalidTotpCodeError` — the two
 * proofs are independent, and neither error, by itself, tells an attacker which one failed.
 *
 * ## The budget is spent before the code is even read
 *
 * `mfa_setup_attempt` is consumed first, on the same reasoning `LoginUseCase` consumes `auth_attempt`
 * before hashing a password: whatever this call does after the limiter answers must not be reachable
 * by an attacker who has already exhausted the budget, and checking after would mean the limiter
 * protects nothing it was not already too late for.
 *
 * ## What happens on the sixth request
 *
 * `mfa_setup_attempt` grants five attempts in fifteen minutes and escalates like `auth_attempt`
 * (`rate-limit-policy.constant.ts`). `consume` runs before the code is read, so attempts one through
 * five each go on to be checked and refused normally — the budget is not yet spent for any of them.
 * It is the **sixth** request that finds the budget already exhausted and gets `allowed: false`
 * without its code ever being looked at; that is the one request where this use-case asks
 * `TotpEnrollmentRepositoryPort.abandonDraft` to discard the draft, so the secret that absorbed five
 * wrong guesses is never confirmable again.
 * **The audit row and the `totp_setup_abandoned` log line are written once, on the request whose
 * `abandonDraft` call actually cleared the row — never on the ones after it.** The rate limit stays
 * blocked for fifteen minutes and every request that arrives during the block reaches this same
 * branch; without checking the write's own result, each of them would produce its own transaction and
 * its own audit row for a draft that was already gone, turning the budget that exists to bound the
 * damage of a guessing run into a generator of unbounded write load for exactly the traffic it is
 * meant to be blocking (`totp-enrollment.port.ts`, `abandonDraft`).
 *
 * ## One answer for "wrong", "no draft" and "expired" — a distinct one for "replayed"
 *
 * `InvalidTotpCodeError` covers every state `enrollment.find` can return short of "a live, unexpired
 * draft whose code matches, at a step not already accepted": telling them apart would let a caller
 * probe whether an enrolment is in progress on an account they do not control, and how long ago it
 * started (`error-code.enums.ts`, `invalid_totp_code`). The one exception is a code that is otherwise
 * correct but was already accepted at that step or an earlier one — `TotpPort.verify`'s `replayed`
 * flag — which answers `TotpCodeReplayedError` instead: STORY-013-01 acceptance 6 asks for a client
 * able to say "that code was already used" rather than "wrong code" on that specific refusal.
 *
 * ## Every refusal is written down, and the decryption failure is not one of them
 *
 * Every branch that answers a `TotpRefusalOutcome` writes `SECURITY_EVENTS.totpVerificationFailed`
 * with that outcome, the same way `LoginUseCase.refuse` writes `signInFailed` for every refused
 * sign-in — without it, five wrong guesses at this endpoint are as invisible as five refused sign-ins
 * would be without that line. Never the code, never the password, never the secret.
 *
 * `FieldEncryptionPort.decrypt` **throwing** is a different fact from a wrong code — it means the
 * running `APP_ENCRYPTION_KEY` cannot read the stored secret at all, most likely because the key was
 * rotated without re-encrypting existing rows. Answering `invalid_totp_code` for that would tell an
 * operator "somebody is guessing" when the truth is "this installation is one config change away from
 * locking out every account with 2FA enabled" — so it is caught explicitly, logged at `error` (the
 * level that means "requires a human", `rules/observability.mdc` rule 7), and answered
 * `503 service_unavailable`, the code this codebase already uses for "a dependency needed to answer
 * is unavailable".
 *
 * ## Enabling and issuing recovery codes are one transaction — the hashing is not
 *
 * `commitEnrollment` and persisting the recovery-code batch run inside the same `unitOfWork.withTenant`
 * block: an account with 2FA enabled and no recovery codes is a support ticket waiting to happen the
 * first time its owner loses their phone, so the two either both commit or neither does (STORY-013-01,
 * acceptance 2). The ten Argon2id hashes that batch costs, though, are minted **before** that
 * transaction opens (`GenerateRecoveryCodesUseCase.mint`) — an interactive transaction holding row
 * locks for the hundreds of milliseconds ten hashes cost on modest hardware is a liability the write
 * itself does not need, and `persist` inside the transaction is a single `createMany` on hashes that
 * already exist.
 *
 * ## The owner is told, outside the transaction
 *
 * A hijacked session enabling 2FA is exactly the scenario «A session is not the second factor» above
 * describes, and requiring the password closes most of it — but a mail is the one signal that reaches
 * the account owner through a channel the session does not control, the same reasoning
 * `ChangePasswordUseCase` gives for notifying on a password change. `notify` runs after the
 * transaction has committed and is fire-and-forget (`MailDispatchPort.dispatch` never throws), on the
 * identical outbox reasoning: no external call inside a transaction (`rules/outbox.mdc`, rule 2).
 */
export class ConfirmTotpUseCase {
  constructor(
    private readonly enrollment: TotpEnrollmentRepositoryPort,
    private readonly totp: TotpPort,
    private readonly fields: FieldEncryptionPort,
    private readonly recoveryCodes: GenerateRecoveryCodesUseCase,
    private readonly users: UserRepositoryPort,
    private readonly hasher: PasswordHasherPort,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly rateLimit: RateLimitPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly audit: AuditLoggerPort,
    private readonly mailDispatcher: MailDispatchPort,
    /** `APP_URL`. Required rather than defaulted: a link built on a guess points at nobody. */
    private readonly appUrl: string,
  ) {}

  async execute(input: ConfirmTotpInput): Promise<ConfirmTotpResult> {
    const decision = await this.rateLimit.consume('mfa_setup_attempt', {
      userId: input.actor.userId,
    });

    if (!decision.allowed) {
      await this.abandon(input.actor);

      throw new RateLimitedError(decision.retryAfterSeconds);
    }

    // Minted before the transaction opens — see the class docstring, «Enabling and issuing recovery
    // codes are one transaction — the hashing is not». Minted even though the TOTP check has not run
    // yet: skipping it when a guess looks likely to fail would make the elapsed time of a confirm
    // attempt depend on whether it was going to succeed, which is the same timing leak this codebase
    // refuses everywhere else.
    const minted = await this.recoveryCodes.mint();

    const { result, credential } = await this.unitOfWork.withTenant(input.actor, () =>
      this.confirm(input, minted),
    );

    await this.rateLimit.reset('mfa_setup_attempt', { userId: input.actor.userId });

    this.logger.info(
      {
        event: SECURITY_EVENTS.totpEnabled,
        organizationId: input.actor.organizationId,
        userId: input.actor.userId,
      },
      'TOTP enrolment confirmed',
    );

    this.notify(input, credential);

    return result;
  }

  private async confirm(
    input: ConfirmTotpInput,
    minted: Awaited<ReturnType<GenerateRecoveryCodesUseCase['mint']>>,
  ): Promise<{ readonly result: ConfirmTotpResult; readonly credential: UserCredentialRecord }> {
    const now = this.clock.now();

    // Both proofs are read before either is judged — the identical reasoning
    // `RegenerateRecoveryCodesUseCase.regenerate` gives for its own `Promise.all`: short-circuiting on
    // one would make the two checks distinguishable by which one this call happened to reach.
    const [passwordCheck, state] = await Promise.all([
      this.verifyPassword(input.actor.userId, input.currentPassword),
      this.enrollment.find(input.actor.userId),
    ]);

    const live =
      state !== null &&
      state.enabledAt === null &&
      state.draftExpiresAt !== null &&
      state.draftExpiresAt.getTime() > now.getTime();

    if (!live) {
      this.refuse('no_draft');

      throw passwordCheck.ok ? new InvalidTotpCodeError() : new ReauthenticationRequiredError();
    }

    // `state` is narrowed to non-null here by `live` above — TypeScript's control-flow analysis
    // carries the `&&` chain through the `const`, so no assertion is needed to read it.
    const { secretEnc, lastCounter } = state;

    // Decrypted for exactly the length of this check and handed nowhere else: not logged, not
    // returned, not kept in a field this class could be asked to read back
    // (`CLAUDE.md`, «Что нельзя логировать никогда»).
    let base32Secret: string;

    try {
      base32Secret = this.decryptOrThrow(secretEnc);
    } catch (cause) {
      this.logger.error(
        {
          event: SECURITY_EVENTS.totpSecretUndecryptable,
          organizationId: input.actor.organizationId,
          userId: input.actor.userId,
        },
        'TOTP secret column could not be decrypted with the running encryption key',
      );

      throw new ServiceUnavailableError({ dependency: 'field-encryption' }, cause);
    }

    const verification = this.totp.verify({
      base32Secret,
      code: input.code,
      at: now,
      sinceCounter: lastCounter,
    });

    if (!verification.accepted) {
      this.refuse(verification.replayed ? 'replayed' : 'wrong_code');

      if (!passwordCheck.ok) throw new ReauthenticationRequiredError();

      throw verification.replayed ? new TotpCodeReplayedError() : new InvalidTotpCodeError();
    }

    if (!passwordCheck.ok) {
      this.refuse('wrong_password');

      throw new ReauthenticationRequiredError();
    }

    const committed = await this.enrollment.commitEnrollment(
      input.actor.userId,
      verification.counter,
      now,
    );

    // Lost a race with a concurrent confirm or with the draft's own expiry landing between the read
    // above and this write — the same refusal as every other way this operation can fail to close.
    if (!committed) {
      this.refuse('race_lost');

      throw new InvalidTotpCodeError();
    }

    const recoveryCodes = await this.recoveryCodes.persist(input.actor.userId, minted);

    await this.audit.record({
      action: 'user.mfa_enabled',
      actor: {
        userId: input.actor.userId,
        organizationId: input.actor.organizationId,
        ipAddress: input.ipAddress,
      },
      target: { type: 'USER', id: input.actor.userId },
      requestId: undefined,
    });

    return { result: { recoveryCodes }, credential: passwordCheck.credential };
  }

  /**
   * `PasswordHasherPort.verify`'s dummy-hash timing floor for an account with no credential row, and
   * the credential itself on success — needed afterwards for `notify`, and reachable only when `ok`
   * is `true` so a caller cannot read it without having already checked the password matched.
   */
  private async verifyPassword(
    userId: string,
    currentPassword: string,
  ): Promise<
    { readonly ok: false } | { readonly ok: true; readonly credential: UserCredentialRecord }
  > {
    const credential = await this.users.findCredential(userId);

    if (credential === null) {
      await this.hasher.verify(this.hasher.dummyHash, currentPassword);

      return { ok: false };
    }

    const matched = await this.hasher.verify(credential.passwordHash, currentPassword);

    return matched ? { ok: true, credential } : { ok: false };
  }

  /** The notice: "two-factor authentication was turned on", best-effort and after the commit. */
  private notify(input: ConfirmTotpInput, credential: UserCredentialRecord): void {
    this.mailDispatcher.dispatch(
      {
        to: credential.email,
        ...renderMfaChangedMail({
          locale: credential.locale,
          appUrl: this.appUrl,
          reason: 'enabled',
        }),
      },
      {
        event: SECURITY_EVENTS.totpEnabled,
        organizationId: input.actor.organizationId,
        userId: input.actor.userId,
      },
    );
  }

  /** `FieldEncryptionPort.decrypt` never returns `null` for a non-null input — see its own contract. */
  private decryptOrThrow(secretEnc: string): string {
    const decrypted = this.fields.decrypt(secretEnc);

    if (decrypted === null) {
      throw new Error('field-encryption: decrypted a non-null ciphertext to null');
    }

    return decrypted;
  }

  private refuse(outcome: TotpRefusalOutcome): void {
    this.logger.warn(
      { event: SECURITY_EVENTS.totpVerificationFailed, outcome },
      'TOTP code refused',
    );
  }

  /**
   * The lockout: discard the draft and write the trail entry — once, on the request whose
   * `abandonDraft` call actually cleared a row. See the class docstring, «What happens on the sixth
   * request».
   */
  private async abandon(actor: ConfirmTotpInput['actor']): Promise<void> {
    const abandoned = await this.unitOfWork.withTenant(actor, async () => {
      const cleared = await this.enrollment.abandonDraft(actor.userId);

      if (!cleared) return false;

      // Same transaction as the discard, on purpose: a lockout that cleared the draft without a
      // record of why would be indistinguishable from a bug.
      await this.audit.record({
        action: 'user.mfa_setup_failed',
        actor: { userId: actor.userId, organizationId: actor.organizationId, ipAddress: undefined },
        target: { type: 'USER', id: actor.userId },
        requestId: undefined,
      });

      return true;
    });

    if (!abandoned) return;

    this.logger.warn(
      {
        event: SECURITY_EVENTS.totpSetupAbandoned,
        organizationId: actor.organizationId,
        userId: actor.userId,
      },
      'TOTP enrolment abandoned: five refused codes exhausted the mfa_setup_attempt budget',
    );
  }
}
