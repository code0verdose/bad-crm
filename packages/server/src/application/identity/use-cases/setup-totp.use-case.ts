import { type FieldEncryptionPort } from '@/application/platform/ports/field-encryption.port.js';
import { type QrCodePort } from '@/application/identity/ports/qr-code.port.js';
import { type TotpEnrollmentRepositoryPort } from '@/application/identity/ports/totp-enrollment.port.js';
import { type TotpPort } from '@/application/identity/ports/totp.port.js';
import { type UserRepositoryPort } from '@/application/identity/ports/user-repository.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type RateLimitPort } from '@/application/platform/ports/rate-limit.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import {
  MfaAlreadyEnabledError,
  RateLimitedError,
  UnauthenticatedError,
} from '@/domain/shared/errors/app.errors.js';

export interface SetupTotpInput {
  readonly actor: { readonly organizationId: string; readonly userId: string };
}

export interface SetupTotpResult {
  /** Shown as text for manual entry — STORY-013-01, acceptance 10: the QR is not the only way in. */
  readonly base32Secret: string;
  readonly uri: string;
  readonly qrSvg: string;
}

/** How long a drafted secret may be confirmed before it has to be requested again. */
const DRAFT_TTL_MINUTES = 15;

/**
 * Drafting a TOTP secret: `POST /auth/2fa/setup`.
 *
 * ## The secret is a draft until `confirm` proves possession
 *
 * `beginDraft` writes `totp_secret_enc` and `totp_draft_expires_at` but never touches
 * `totp_enabled_at` — the column `AuthenticateSessionQuery` and every future login check will read.
 * 2FA is off for this account for as long as that column is null, whatever this endpoint has written,
 * which is exactly STORY-013-01 acceptance 1: "секрет сохраняется как черновой ... поэтому 2FA ещё не
 * действует".
 *
 * ## Why the write, not a read, decides "already enabled"
 *
 * `TotpEnrollmentRepositoryPort.beginDraft` is `UPDATE ... WHERE totp_enabled_at IS NULL`. Reading
 * the state first and branching on it would leave a window between the read and the write in which a
 * `confirm` on another request could enable 2FA — this call would then overwrite a secret an
 * authenticator app has already been pointed at, with a new one nobody has scanned, silently. The
 * conditional write closes that window: whichever request's `UPDATE` reaches PostgreSQL after 2FA is
 * enabled matches no row and answers `false`.
 *
 * ## What never happens
 *
 * The generated secret is encrypted before it is written and is never logged, never returned in a
 * second response, and never kept in a variable this class does not need to read it back from
 * (`rules/security.mdc`, `CLAUDE.md` §«Что нельзя логировать никогда»).
 *
 * ## The budget, shared with `confirm`
 *
 * `mfa_setup_attempt` is consumed here too — the same policy `ConfirmTotpUseCase` spends from, keyed
 * on the same caller — so drafting and confirming a TOTP secret share one five-per-fifteen-minutes
 * budget rather than `setup` being the one step of the enrolment flow with no limit at all. Nothing
 * here resets the budget on success: a `setup` call is not proof of anything, and resetting it would
 * let a caller who has exhausted `confirm`'s budget buy a fresh one just by asking for a new QR code.
 */
export class SetupTotpUseCase {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly enrollment: TotpEnrollmentRepositoryPort,
    private readonly totp: TotpPort,
    private readonly qr: QrCodePort,
    private readonly fields: FieldEncryptionPort,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly rateLimit: RateLimitPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(input: SetupTotpInput): Promise<SetupTotpResult> {
    const decision = await this.rateLimit.consume('mfa_setup_attempt', {
      userId: input.actor.userId,
    });

    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);

    const generated = await this.unitOfWork.withTenant(input.actor, async () => {
      const account = await this.users.findById(input.actor.userId);

      // Unreachable through a normal request — the caller already holds a session for this account —
      // and answered the same way `ConfirmPasswordResetUseCase` answers the identical race: the
      // account was soft-deleted or moved in the few milliseconds between the guard reading the
      // session and this transaction opening.
      if (account === null) throw new UnauthenticatedError();

      const secret = this.totp.generateSecret(account.email);
      const draftExpiresAt = new Date(this.clock.now().getTime() + DRAFT_TTL_MINUTES * 60 * 1000);

      // `encrypt` never returns `null` for a non-null input (`FieldEncryptionPort`'s own contract) —
      // there is deliberately no `?? ''` fallback here. A silent empty string would still satisfy
      // `beginDraft`'s `NOT NULL` and write a row `ConfirmTotpUseCase.decryptOrThrow` cannot read
      // back, turning "the encryptor has a bug" into "this account can never enable 2FA again"
      // instead of a loud, immediate failure of this request.
      const secretEnc = this.fields.encrypt(secret.base32Secret);

      if (secretEnc === null) {
        throw new Error('field-encryption: encrypted a non-null plaintext to null');
      }

      const written = await this.enrollment.beginDraft(
        input.actor.userId,
        secretEnc,
        draftExpiresAt,
      );

      if (!written) throw new MfaAlreadyEnabledError();

      return secret;
    });

    // QR rendering needs neither the transaction nor the tenant scope — it is a pure function of the
    // URI — so it runs after the scope has closed, the same way this codebase keeps anything that is
    // not a database write outside the block that holds a connection.
    const qrSvg = await this.qr.renderSvg(generated.uri);

    return { base32Secret: generated.base32Secret, uri: generated.uri, qrSvg };
  }
}
