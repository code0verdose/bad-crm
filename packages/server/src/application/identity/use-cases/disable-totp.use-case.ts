import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import { type RecoveryCodeMatcher } from '@/application/identity/use-cases/recovery-code-matcher.use-case.js';
import {
  type RecoveryCodeCandidate,
  type RecoveryCodeRepositoryPort,
} from '@/application/identity/ports/recovery-code-repository.port.js';
import {
  type TotpEnrollmentRepositoryPort,
  type TotpEnrollmentState,
} from '@/application/identity/ports/totp-enrollment.port.js';
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
import {
  isWellFormedRecoveryCode,
  normalizeRecoveryCode,
} from '@/domain/identity/recovery-code.value.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import {
  MfaRequiredByPolicyError,
  RateLimitedError,
  ReauthenticationRequiredError,
  ServiceUnavailableError,
} from '@/domain/shared/errors/app.errors.js';
import { type MfaPolicyQuery } from '@/application/organization/use-cases/mfa-policy.query.js';

export interface DisableTotpInput {
  readonly actor: { readonly organizationId: string; readonly userId: string };
  readonly password: string;
  /** Either a live 6-digit TOTP code or a recovery code — see the class docstring. */
  readonly code: string;
  /** The caller's address, for the audit trail — `undefined` off a socket with no peer address. */
  readonly ipAddress: string | undefined;
}

/** The shape of a live authenticator-app code — `mfa.validator.ts`'s `totpCodeSchema`, duplicated
 *  here because a presentation-layer schema is not importable from `application` (`rules/hexagonal-
 *  backend.mdc`); the two patterns are the same string by construction, not by coincidence. */
const TOTP_CODE_PATTERN = /^\d{6}$/;

/** Every row the two proofs are judged against, read in one scope before any Argon2id runs. */
interface CallerProofs {
  readonly credential: UserCredentialRecord | null;
  /** The enrolment, for a code of TOTP shape; `null` for a recovery code, which does not need it. */
  readonly enrollment: TotpEnrollmentState | null;
  /** The unused recovery rows, for a code that is not of TOTP shape; empty otherwise. */
  readonly candidates: readonly RecoveryCodeCandidate[];
}

/** Which of the two accepted proofs a presented `code` turned out to be, and what committing it needs. */
type SecondFactorCheck =
  | { readonly ok: false }
  | { readonly ok: true; readonly kind: 'totp'; readonly counter: number }
  | { readonly ok: true; readonly kind: 'recovery_code'; readonly recoveryCodeId: string };

/**
 * Turning 2FA off, deliberately: `POST /auth/2fa/disable` (STORY-013-04, acceptance 1–3).
 *
 * ## Two proofs, and the account's second factor accepts either as the second one
 *
 * The password is always required and always checked. The `code` field accepts **either** a live
 * TOTP code or an unused recovery code (acceptance 2) — a person who lost their authenticator but
 * still has a printed recovery sheet must be able to turn 2FA off with what they actually have,
 * exactly as the second-factor step of sign-in will accept either once STORY-013-03 wires it up. The
 * shape of what was typed decides which check runs: six digits is a TOTP code
 * (`TOTP_CODE_PATTERN`), anything else is tried as a recovery code. The two shapes cannot collide —
 * a recovery code is ten characters, `RECOVERY_CODE_LENGTH` — so there is no input this branch reads
 * ambiguously.
 *
 * **Both proofs are read before either is judged**, the identical reasoning
 * `RegenerateRecoveryCodesUseCase` gives for its own `Promise.all`: the password digest is verified
 * unconditionally, and the second-factor check runs whether or not the password already failed.
 * Short-circuiting on the password would make the two checks distinguishable by which one this call
 * happened to reach, and — for the recovery-code branch specifically — checking the code only after
 * the password is known to be right would still leak nothing, but checking it only *before* the
 * password is known would risk the opposite mistake: see the next section.
 *
 * ## A recovery code is matched, never spent, until the password has also checked out
 *
 * `RecoveryCodeMatcher.compare` only compares — it does not call `RecoveryCodeRepositoryPort.markUsed`.
 * That split exists for this use-case specifically: spending a code is supposed to cost the account
 * exactly one of its ten, and a request that presents a valid recovery code alongside a *wrong*
 * password must not burn it. Only after `passwordCheck.ok` is confirmed does `commit` call
 * `markUsed` — the same atomic, conditional `UPDATE ... WHERE used_at IS NULL` every other consumer
 * of a recovery code goes through (`RecoveryCodeMatcher`'s own docstring explains why the match and
 * the spend live in two different places rather than two different implementations). A TOTP code is
 * symmetric: `checkTotp` verifies it without advancing `totp_last_counter`, and `commit` advances the
 * counter only once the password has also checked out — the identical ordering
 * `RegenerateRecoveryCodesUseCase.checkTotp`/`regenerate` already uses for the same reason.
 *
 * ## One refusal for every way the two proofs can fail
 *
 * `ReauthenticationRequiredError` answers a wrong password, a wrong or absent TOTP code, an unknown
 * or already-used recovery code, and an account with no TOTP enrolled at all — the same fold
 * `RegenerateRecoveryCodesUseCase` documents for its own reauthentication. 2FA stays enabled in every
 * one of those cases (acceptance 2). Acceptance 3 — a stolen access token with no password — is not a
 * separate branch: the password check simply fails, and the answer is identical.
 *
 * ## Disabling and deleting every recovery code are one transaction; verifying the caller is not
 *
 * `enrollment.disable` and `recoveryCodes.deleteAllForUser` both run inside the single
 * `unitOfWork.withTenant` block STORY-013-04's acceptance 1 asks for ("**все** коды восстановления
 * удаляются в той же транзакции"): an account with 2FA cleared and an old recovery-code batch still
 * valid would let that batch re-arm a *future* enrolment nobody scanned a QR code for.
 *
 * **Verifying the caller costs Argon2id, and Argon2id may not run inside that transaction.** Since
 * STORY-013-06 every hash and every verification first queues for one of
 * `AUTH_ARGON2_CONCURRENCY` slots and may wait `AUTH_ARGON2_QUEUE_TIMEOUT_MS` for it. A recovery
 * code costs `RECOVERY_CODE_COUNT` verifications, each queueing separately: ten waits, on a pinned
 * pool connection, inside a transaction whose budget is five seconds (`tenant.context.ts`). Under
 * the saturation the ceiling exists for, the transaction is killed first and the caller is answered
 * `500 internal_error` in place of the `503` with a `Retry-After` the queue produced. So this
 * command runs three phases instead of one: `read` takes every row the proofs are judged against in
 * one short scope, the verifications run holding nothing, and `disable` opens a second scope to
 * write. Nothing atomic is given up — the two writes that decide the outcome, `advanceCounter` and
 * `markUsed`, are conditional statements that answer `false` when somebody else got there first,
 * which is the same guarantee they gave inside one Read Committed transaction.
 *
 * What bounds concurrent load on this path besides the ceiling is `mfa_reauth_attempt`, spent in
 * `execute` before the first scope opens: a caller who has exhausted the budget never reaches the
 * database at all.
 *
 * ## The owner is told, outside the transaction
 *
 * The same notice `ConfirmTotpUseCase` and `RegenerateRecoveryCodesUseCase` send for the same class
 * of event — a credential controlling the account changed — fire-and-forget after the commit
 * (`rules/outbox.mdc`, rule 2).
 */
export class DisableTotpUseCase {
  constructor(
    private readonly enrollment: TotpEnrollmentRepositoryPort,
    private readonly totp: TotpPort,
    private readonly fields: FieldEncryptionPort,
    private readonly recoveryCodes: RecoveryCodeRepositoryPort,
    private readonly matcher: RecoveryCodeMatcher,
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
    private readonly policies: MfaPolicyQuery,
  ) {}

  async execute(input: DisableTotpInput): Promise<void> {
    const decision = await this.rateLimit.consume('mfa_reauth_attempt', {
      userId: input.actor.userId,
    });

    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);

    const now = this.clock.now();

    // Read in one scope, judged holding none, written in a second — see the class docstring,
    // «Verifying the caller costs Argon2id, and Argon2id may not run inside the transaction».
    const proofs = await this.unitOfWork.withTenant(input.actor, () => this.read(input));

    const [passwordCheck, secondFactor] = await Promise.all([
      this.verifyPassword(proofs.credential, input.password),
      this.verifySecondFactor(input.actor, proofs, input.code, now),
    ]);

    if (!passwordCheck.ok || !secondFactor.ok) throw new ReauthenticationRequiredError();

    await this.unitOfWork.withTenant(input.actor, () => this.disable(input, secondFactor, now));

    const credential = passwordCheck.credential;

    await this.rateLimit.reset('mfa_reauth_attempt', { userId: input.actor.userId });

    this.logger.info(
      {
        event: SECURITY_EVENTS.totpDisabled,
        organizationId: input.actor.organizationId,
        userId: input.actor.userId,
      },
      'TOTP disabled by its own account owner',
    );

    this.notify(input, credential);
  }

  /**
   * Everything the two proofs are judged against, in one tenant-scoped read and no computation.
   *
   * The recovery-code candidates are read only for a code that could be one: a six-digit string is
   * a TOTP code by shape, and listing ten rows for it would be a read nothing consumes.
   */
  private async read(input: DisableTotpInput): Promise<CallerProofs> {
    const isTotpShape = TOTP_CODE_PATTERN.test(input.code);

    return {
      credential: await this.users.findCredential(input.actor.userId),
      enrollment: isTotpShape ? await this.enrollment.find(input.actor.userId) : null,
      candidates: isTotpShape ? [] : await this.matcher.listCandidates(input.actor.userId),
    };
  }

  private async disable(
    input: DisableTotpInput,
    secondFactor: Extract<SecondFactorCheck, { ok: true }>,
    now: Date,
  ): Promise<void> {
    // STORY-013-04 acceptance 4 / STORY-013-05 acceptance 6, and it is checked **after** both proofs
    // rather than before them. Refusing first would answer «your organization requires 2FA» to
    // somebody who has not proved they hold the account — a free read of the policy for anybody with
    // a stolen access token, and a free confirmation that this particular colleague is covered by
    // it. Two extra statements on an operation that runs a handful of times per account.
    //
    // `covered`, not `gate`: whether the grace period has run out decides what a *session* may do,
    // and has nothing to say about whether a factor already in place may be removed. Somebody inside
    // their grace period is still somebody the policy requires a factor of.
    const verdict = await this.policies.gateFor({
      userId: input.actor.userId,
      hasSecondFactor: true,
    });

    if (verdict.covered) throw new MfaRequiredByPolicyError();

    const committed = await this.commit(input.actor.userId, secondFactor, now);

    // Lost a race with a concurrent disable, regeneration or sign-in that already advanced the same
    // counter, or already spent the same recovery code — the identical refusal as every other way
    // this call can fail to close (`RegenerateRecoveryCodesUseCase.regenerate` refuses the same way).
    if (!committed) throw new ReauthenticationRequiredError();

    const recoveryCodesDeleted = await this.recoveryCodes.deleteAllForUser(input.actor.userId);

    await this.audit.record({
      action: 'user.mfa_disabled',
      actor: {
        userId: input.actor.userId,
        organizationId: input.actor.organizationId,
        ipAddress: input.ipAddress,
      },
      target: { type: 'USER', id: input.actor.userId },
      after: { recoveryCodesDeleted, secondFactorKind: secondFactor.kind },
      requestId: undefined,
    });
  }

  /** Advances the TOTP counter or spends the matched recovery code; `enrollment.disable` last. */
  private async commit(
    userId: string,
    secondFactor: Extract<SecondFactorCheck, { ok: true }>,
    now: Date,
  ): Promise<boolean> {
    if (secondFactor.kind === 'totp') {
      const advanced = await this.enrollment.advanceCounter(userId, secondFactor.counter);

      if (!advanced) return false;
    } else {
      const spent = await this.recoveryCodes.markUsed(userId, secondFactor.recoveryCodeId, now);

      if (!spent) return false;
    }

    return await this.enrollment.disable(userId);
  }

  private async verifyPassword(
    credential: UserCredentialRecord | null,
    password: string,
  ): Promise<
    { readonly ok: false } | { readonly ok: true; readonly credential: UserCredentialRecord }
  > {
    if (credential === null) {
      await this.hasher.verify(this.hasher.dummyHash, password);

      return { ok: false };
    }

    const matched = await this.hasher.verify(credential.passwordHash, password);

    return matched ? { ok: true, credential } : { ok: false };
  }

  private async verifySecondFactor(
    actor: DisableTotpInput['actor'],
    proofs: CallerProofs,
    code: string,
    now: Date,
  ): Promise<SecondFactorCheck> {
    if (TOTP_CODE_PATTERN.test(code)) return this.checkTotp(actor, proofs.enrollment, code, now);

    const normalized = normalizeRecoveryCode(code);

    // Refused before any Argon2id verification runs — the identical load-shedding
    // `ConsumeRecoveryCodeUseCase` applies before calling the same matcher.
    if (!isWellFormedRecoveryCode(normalized)) return { ok: false };

    const matchId = await this.matcher.compare(proofs.candidates, normalized);

    return matchId === null
      ? { ok: false }
      : { ok: true, kind: 'recovery_code', recoveryCodeId: matchId };
  }

  /** Verifies the presented TOTP code without touching `totp_last_counter` — see the class docstring. */
  private checkTotp(
    actor: DisableTotpInput['actor'],
    state: TotpEnrollmentState | null,
    code: string,
    now: Date,
  ): SecondFactorCheck {
    if (state === null || state.enabledAt === null) return { ok: false };

    let base32Secret: string;

    try {
      const decrypted = this.fields.decrypt(state.secretEnc);

      // `FieldEncryptionPort.decrypt` never returns `null` for a non-null input — see its own
      // contract. Guarded rather than asserted so a port that ever broke that promise fails here,
      // loudly and in one place, instead of handing an empty secret to the verifier.
      if (decrypted === null) {
        throw new Error('field-encryption: decrypted a non-null ciphertext to null');
      }

      base32Secret = decrypted;
    } catch (cause) {
      // Not a wrong code — the running `APP_ENCRYPTION_KEY` cannot read the stored secret at all,
      // the identical fact and handling `ConfirmTotpUseCase` and `RegenerateRecoveryCodesUseCase`
      // give their own matching catch.
      this.logger.error(
        {
          event: SECURITY_EVENTS.totpSecretUndecryptable,
          organizationId: actor.organizationId,
          userId: actor.userId,
        },
        'TOTP secret column could not be decrypted with the running encryption key',
      );

      throw new ServiceUnavailableError({ dependency: 'field-encryption' }, cause);
    }

    const verification = this.totp.verify({
      base32Secret,
      code,
      at: now,
      sinceCounter: state.lastCounter,
    });

    return verification.accepted
      ? { ok: true, kind: 'totp', counter: verification.counter }
      : { ok: false };
  }

  /** The notice: "two-factor authentication was turned off", best-effort and after the commit. */
  private notify(input: DisableTotpInput, credential: UserCredentialRecord): void {
    this.mailDispatcher.dispatch(
      {
        to: credential.email,
        ...renderMfaChangedMail({
          locale: credential.locale,
          appUrl: this.appUrl,
          reason: 'disabled',
        }),
      },
      {
        event: SECURITY_EVENTS.totpDisabled,
        organizationId: input.actor.organizationId,
        userId: input.actor.userId,
      },
    );
  }
}
