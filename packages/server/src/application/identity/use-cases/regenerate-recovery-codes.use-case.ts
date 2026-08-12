import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import { type GenerateRecoveryCodesUseCase } from '@/application/identity/use-cases/generate-recovery-codes.use-case.js';
import { type RecoveryCodeRepositoryPort } from '@/application/identity/ports/recovery-code-repository.port.js';
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
  RateLimitedError,
  ReauthenticationRequiredError,
  ServiceUnavailableError,
} from '@/domain/shared/errors/app.errors.js';

export interface RegenerateRecoveryCodesInput {
  readonly actor: { readonly organizationId: string; readonly userId: string };
  readonly currentPassword: string;
  readonly totpCode: string;
  /** The caller's address, for the audit trail — `undefined` off a socket with no peer address. */
  readonly ipAddress: string | undefined;
}

/** The TOTP half of reauthentication, checked without mutating the anti-replay counter. */
type TotpCheck = { readonly valid: false } | { readonly valid: true; readonly counter: number };

export interface RegenerateRecoveryCodesResult {
  readonly recoveryCodes: readonly string[];
}

/**
 * Replacing the whole recovery-code set: `POST /auth/2fa/recovery-codes/regenerate`.
 *
 * ## Two credentials, one refusal
 *
 * `ReauthenticationRequiredError` is the answer whether the password is wrong, the TOTP code is
 * wrong, or 2FA is not even enabled on the account — the three states are folded on purpose
 * (STORY-013-02, acceptance 8). Telling them apart would tell a caller which of the two proofs they
 * are missing, and «this account has no TOTP enrolled» is itself a fact about the account a session
 * holder should not be able to fish for through this endpoint.
 *
 * **Both checks run before either result is looked at.** The password digest is verified
 * unconditionally; the TOTP check runs whenever an enrolment exists, independent of whether the
 * password already failed. Short-circuiting on the first failure would make the two checks
 * distinguishable by which one this call happened to reach — the same reasoning `LoginUseCase`
 * applies to verifying every candidate password rather than stopping at the first miss.
 *
 * ## The counter advances only once both proofs are accepted, and its own result is checked
 *
 * `checkTotp` verifies the presented code but does **not** advance `totp_last_counter` — advancing it
 * is a mutation, and doing it before the password has been judged would let a caller with a stolen
 * session token but no password burn the account owner's current TOTP code by presenting it here with
 * any wrong password: the code would come back unusable at the real sign-in a few seconds later even
 * though this call never succeeded. So the counter moves in one place, `regenerate`, only after both
 * `passwordOk` and `totpCheck.valid` are true — exactly as a future sign-in verification will advance
 * it (`totp.port.ts`) — and **its return value decides the outcome**: `false` means another request
 * (a doubled form submission, most plausibly) already advanced past this counter first, and answering
 * success anyway would let two concurrent regenerations each believe they own the recovery-code batch
 * they just deleted and reissued, when only the second write actually stands.
 *
 * ## Old codes are gone before new ones exist, in the same transaction — the hashing is not
 *
 * `deleteAllForUser` runs before the new batch is persisted, inside one `unitOfWork.withTenant` block:
 * STORY-013-02 acceptance 7 states this explicitly ("**все** старые хеши удаляются в той же
 * транзакции"), and the ordering is what makes a mid-transaction failure land on "nothing changed"
 * rather than "briefly zero recovery codes existed and the write that would have fixed it never
 * landed". The ten Argon2id hashes the new batch costs are minted before this transaction opens
 * (`GenerateRecoveryCodesUseCase.mint`), for the same reason `ConfirmTotpUseCase` mints early: an
 * interactive transaction is not the place to hold row locks open for hundreds of milliseconds of
 * hashing.
 *
 * ## The owner is told, outside the transaction
 *
 * The same notice `ConfirmTotpUseCase` sends, for the same reason: reauthentication narrows who can
 * reach this endpoint, but a mail is the one signal that reaches the account owner through a channel
 * a hijacked session does not control. Fire-and-forget, after the transaction has committed
 * (`rules/outbox.mdc`, rule 2).
 */
export class RegenerateRecoveryCodesUseCase {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly enrollment: TotpEnrollmentRepositoryPort,
    private readonly totp: TotpPort,
    private readonly fields: FieldEncryptionPort,
    private readonly codes: RecoveryCodeRepositoryPort,
    private readonly hasher: PasswordHasherPort,
    private readonly recoveryCodes: GenerateRecoveryCodesUseCase,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly rateLimit: RateLimitPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly audit: AuditLoggerPort,
    private readonly mailDispatcher: MailDispatchPort,
    /** `APP_URL`. Required rather than defaulted: a link built on a guess points at nobody. */
    private readonly appUrl: string,
  ) {}

  async execute(input: RegenerateRecoveryCodesInput): Promise<RegenerateRecoveryCodesResult> {
    const decision = await this.rateLimit.consume('mfa_reauth_attempt', {
      userId: input.actor.userId,
    });

    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);

    // Minted before the transaction opens — see the class docstring's last section. Minted before
    // either credential is judged, for the identical timing reason `ConfirmTotpUseCase` mints early.
    const minted = await this.recoveryCodes.mint();

    const { result, credential } = await this.unitOfWork.withTenant(input.actor, () =>
      this.regenerate(input, minted),
    );

    await this.rateLimit.reset('mfa_reauth_attempt', { userId: input.actor.userId });

    this.logger.info(
      {
        event: SECURITY_EVENTS.totpRecoveryCodesRegenerated,
        organizationId: input.actor.organizationId,
        userId: input.actor.userId,
        issuedCount: result.recoveryCodes.length,
      },
      'recovery codes regenerated',
    );

    this.notify(input, credential);

    return result;
  }

  private async regenerate(
    input: RegenerateRecoveryCodesInput,
    minted: Awaited<ReturnType<GenerateRecoveryCodesUseCase['mint']>>,
  ): Promise<{
    readonly result: RegenerateRecoveryCodesResult;
    readonly credential: UserCredentialRecord;
  }> {
    const [passwordCheck, totpCheck] = await Promise.all([
      this.verifyPassword(input.actor.userId, input.currentPassword),
      this.checkTotp(input.actor, input.totpCode),
    ]);

    if (!passwordCheck.ok || !totpCheck.valid) throw new ReauthenticationRequiredError();

    // Only now — both proofs accepted — does the anti-replay counter move, and its own result
    // decides the outcome: `false` is a race with a concurrent regeneration or sign-in that already
    // advanced past this step, not a state this call may paper over by continuing anyway.
    const advanced = await this.enrollment.advanceCounter(input.actor.userId, totpCheck.counter);

    if (!advanced) throw new ReauthenticationRequiredError();

    const previousCount = await this.codes.deleteAllForUser(input.actor.userId);
    const recoveryCodes = await this.recoveryCodes.persist(input.actor.userId, minted);

    await this.audit.record({
      action: 'user.mfa_recovery_codes_regenerated',
      actor: {
        userId: input.actor.userId,
        organizationId: input.actor.organizationId,
        ipAddress: input.ipAddress,
      },
      target: { type: 'USER', id: input.actor.userId },
      before: { previousCount },
      after: { issuedCount: recoveryCodes.length },
      requestId: undefined,
    });

    return { result: { recoveryCodes }, credential: passwordCheck.credential };
  }

  private async verifyPassword(
    userId: string,
    currentPassword: string,
  ): Promise<
    { readonly ok: false } | { readonly ok: true; readonly credential: UserCredentialRecord }
  > {
    const credential = await this.users.findCredential(userId);

    if (credential === null) {
      // Costs one verification against the dummy digest all the same, exactly as `LoginUseCase` pays
      // for a lookup that found nobody: this branch must not be distinguishable by elapsed time from
      // an account whose digest simply did not match.
      await this.hasher.verify(this.hasher.dummyHash, currentPassword);

      return { ok: false };
    }

    const matched = await this.hasher.verify(credential.passwordHash, currentPassword);

    return matched ? { ok: true, credential } : { ok: false };
  }

  /** The notice: "your recovery codes were regenerated", best-effort and after the commit. */
  private notify(input: RegenerateRecoveryCodesInput, credential: UserCredentialRecord): void {
    this.mailDispatcher.dispatch(
      {
        to: credential.email,
        ...renderMfaChangedMail({
          locale: credential.locale,
          appUrl: this.appUrl,
          reason: 'recovery_codes_regenerated',
        }),
      },
      {
        event: SECURITY_EVENTS.totpRecoveryCodesRegenerated,
        organizationId: input.actor.organizationId,
        userId: input.actor.userId,
      },
    );
  }

  /** Verifies the presented code without touching `totp_last_counter` — see the class docstring. */
  private async checkTotp(
    actor: RegenerateRecoveryCodesInput['actor'],
    code: string,
  ): Promise<TotpCheck> {
    const state = await this.enrollment.find(actor.userId);

    if (state === null || state.enabledAt === null) return { valid: false };

    let base32Secret: string;

    try {
      const decrypted = this.fields.decrypt(state.secretEnc);

      if (decrypted === null) {
        throw new Error('field-encryption: decrypted a non-null ciphertext to null');
      }

      base32Secret = decrypted;
    } catch (cause) {
      // Not a wrong code — the running `APP_ENCRYPTION_KEY` cannot read the stored secret at all,
      // same fact and same handling as `ConfirmTotpUseCase`'s identical catch.
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

    const now = this.clock.now();
    const verification = this.totp.verify({
      base32Secret,
      code,
      at: now,
      sinceCounter: state.lastCounter,
    });

    return verification.accepted
      ? { valid: true, counter: verification.counter }
      : { valid: false };
  }
}
