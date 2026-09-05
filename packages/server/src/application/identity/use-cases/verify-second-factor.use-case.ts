import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import {
  type MfaPendingTokenClaims,
  type MfaPendingTokenPort,
} from '@/application/identity/ports/mfa-pending-token.port.js';
import { type TotpEnrollmentRepositoryPort } from '@/application/identity/ports/totp-enrollment.port.js';
import { type TotpPort } from '@/application/identity/ports/totp.port.js';
import {
  type UserRecord,
  type UserRepositoryPort,
} from '@/application/identity/ports/user-repository.port.js';
import { type ConsumeRecoveryCodeUseCase } from '@/application/identity/use-cases/consume-recovery-code.use-case.js';
import {
  type IssueSessionUseCase,
  type SessionClient,
} from '@/application/identity/use-cases/issue-session.use-case.js';
import { type AuthenticatedLogin } from '@/application/identity/use-cases/login.use-case.js';
import { type OrganizationRepositoryPort } from '@/application/organization/ports/organization-repository.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type FieldEncryptionPort } from '@/application/platform/ports/field-encryption.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type RateLimitPort } from '@/application/platform/ports/rate-limit.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { maskIpAddress } from '@/domain/identity/mask-ip-address.util.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import {
  AccountRefusedError,
  MfaCodeReplayedError,
  MfaInvalidCodeError,
  MfaTokenExpiredError,
  RateLimitedError,
  ServiceUnavailableError,
  UnauthenticatedError,
} from '@/domain/shared/errors/app.errors.js';

export interface VerifySecondFactorInput {
  /** The intermediate credential `POST /auth/login` handed back with `status: 'mfa_required'`. */
  readonly mfaToken: string;
  /** Six digits from an authenticator, or a recovery code — the shape decides which. */
  readonly code: string;
  readonly client: SessionClient;
}

/**
 * The shape of a live authenticator-app code.
 *
 * The same constant `DisableTotpUseCase` declares, and duplicated for the same stated reason: a
 * presentation-layer schema is not importable from `application` (`rules/hexagonal-backend.mdc`).
 * The two are the same string by construction — six digits — not by coincidence.
 */
const TOTP_CODE_PATTERN = /^\d{6}$/;

/** Which proof was accepted; it becomes a field of the audit entry and of the log line. */
type SecondFactorKind = 'totp' | 'recovery_code';

/** Everything the transaction produced, so nothing has to be read a second time outside it. */
interface CompletedSignIn {
  readonly session: Awaited<ReturnType<IssueSessionUseCase['execute']>>;
  readonly kind: SecondFactorKind;
  readonly account: UserRecord;
  readonly organization: AuthenticatedLogin['organization'];
}

/** Why a second factor was refused — a closed set, because it is the field an alert selects on. */
type SecondFactorRefusal =
  | 'token_unusable'
  | 'attempts_exhausted'
  | 'account_attempts_exhausted'
  | 'not_enrolled'
  | 'wrong_code'
  | 'replayed'
  | 'account_unusable';

/**
 * The second half of a sign-in: `POST /auth/2fa/verify` (STORY-013-03, acceptance 2, 4–7).
 *
 * ## What it is allowed to assume, and what it checks anyway
 *
 * A valid `mfaToken` means one thing: some minutes ago a password verified for this account in this
 * organization. It does **not** mean the account may still sign in — five minutes is long enough to
 * be offboarded in, and offboarding revokes every session family without knowing a second-factor
 * step is in flight (STORY-012). So the account row is re-read inside the transaction and a status
 * that is no longer `ACTIVE` refuses here exactly as it would have refused at the password step:
 * `account_suspended` for a suspension (reachable only after a credential verified, which is what
 * makes it sayable), and the ordinary refused credential for a row that is gone.
 *
 * ## The budget comes first, and it is keyed on the token
 *
 * `mfa_verify_attempt` is consumed before the secret is decrypted and before any Argon2id
 * comparison of a recovery code — the same rule `LoginUseCase` states for `auth_attempt`, and for
 * the same reason: work an exhausted caller can still make the server do is work the limiter does
 * not limit. It cannot be consumed before the token is verified, because the subject **is** the
 * token's `jti` (`rate-limit.port.ts` works through why `userId` cannot carry this policy) — and a
 * `jti` read out of an unverified string would be a counter an attacker picks. Verifying the JWT
 * first costs one HMAC and one denylist lookup, neither of which is the cost the budget exists to
 * bound.
 *
 * **The sixth attempt kills the token rather than asking the caller to wait.** `mfa_token_expired`,
 * not `rate_limited`: the catalog already states that this code covers "voided after five failed
 * attempts" (`error-code.enums.ts`), and a `Retry-After` would send somebody back with a credential
 * that can never work again. The way back is the password, which mints a fresh token with a fresh
 * `jti` and therefore a fresh budget. The revocation is written even though the limiter would block
 * this `jti` for the rest of its life anyway: a token whose invalidation depended on a counter in
 * another store would be live again the moment that store forgot it.
 *
 * ## One transaction, so a spent code always has a session to show for it
 *
 * Reading the account, verifying the factor, spending it (`advanceCounter` or, through
 * `ConsumeRecoveryCodeUseCase`, `markUsed`), revoking the intermediate token and writing the session
 * all happen inside one `withTenant`. `ConsumeRecoveryCodeUseCase` opens a scope of its own and
 * **joins** this one — same organization, so `withTenant` reuses the outer transaction rather than
 * opening a second (`tenant.context.ts`). That nesting is the point rather than an accident: a
 * recovery code spent in one transaction and a session written in another would, on any failure
 * between them, cost somebody one of their ten codes and give them nothing.
 *
 * The token is revoked **before** the session is written, inside the same scope. If the write then
 * fails, the caller has to present the password again — the safe direction. The other order would
 * leave a live intermediate token beside a live session for as long as the revocation took to fail.
 *
 * ## Which branch runs is decided by the shape of what was typed
 *
 * Six digits is an authenticator code, anything else is tried as a recovery code — the identical
 * rule `DisableTotpUseCase` applies, and the two shapes cannot collide because a recovery code is
 * ten characters. The alternative — a `kind` field chosen by the client — would let a caller aim a
 * six-digit guess at the recovery batch, where each attempt costs ten Argon2id verifications.
 *
 * The recovery branch delegates wholesale to `ConsumeRecoveryCodeUseCase` rather than reimplementing
 * any of it: the fixed-cost match, the shape check that precedes it, the conditional spend that
 * decides the race, its own `mfa_recovery_consume_attempt` budget and its own audit entry all belong
 * to that use-case, which was written for this caller and until now had none (STORY-013-02).
 */
export class VerifySecondFactorUseCase {
  constructor(
    private readonly mfaTokens: MfaPendingTokenPort,
    private readonly enrollment: TotpEnrollmentRepositoryPort,
    private readonly totp: TotpPort,
    private readonly fields: FieldEncryptionPort,
    private readonly consumeRecoveryCode: ConsumeRecoveryCodeUseCase,
    private readonly users: UserRepositoryPort,
    private readonly organizations: OrganizationRepositoryPort,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly issueSession: IssueSessionUseCase,
    private readonly rateLimit: RateLimitPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: VerifySecondFactorInput): Promise<AuthenticatedLogin> {
    const ipMasked = maskIpAddress(input.client.ipAddress);
    const claims = await this.mfaTokens.verify(input.mfaToken);

    if (claims === undefined) {
      this.refuse('token_unusable', ipMasked);

      throw new MfaTokenExpiredError();
    }

    const decision = await this.rateLimit.consume('mfa_verify_attempt', { jti: claims.jti });

    if (!decision.allowed) {
      await this.mfaTokens.revoke(claims);
      this.refuse('attempts_exhausted', ipMasked);

      throw new MfaTokenExpiredError();
    }

    // The second budget, and the one that actually bounds guessing.
    //
    // The budget above is keyed on `jti`, so it dies with the token — and a new token costs one
    // correct password, which the attacker this feature exists to stop is the one who has it.
    // `auth_attempt` does not close the loop either: `LoginUseCase` resets it on every verified
    // password, the branch that mints this very token included. Without the counter below,
    // `login → five guesses → login → five guesses` had no bound at all, and a ±1-step window
    // leaves three live codes in a million — hours from one host, not centuries.
    //
    // Keyed on `(ipAddress, userId)` so it survives the rotation, exactly as the recovery-code
    // budget already was. Spent **after** the token proved usable, so an expired token cannot be
    // used to burn a stranger's budget, and **before** any comparison, so it bounds the work as
    // well as the guesses.
    const perAccount = await this.rateLimit.consume('mfa_verify_account_attempt', {
      userId: claims.userId,
      ipAddress: input.client.ipAddress,
    });

    if (!perAccount.allowed) {
      // The token is left alone: this refusal is about the account being hammered, not about this
      // token being spent, and voiding it would let a flood from one address end somebody else's
      // half-finished sign-in.
      this.refuse('account_attempts_exhausted', ipMasked);

      throw new RateLimitedError(perAccount.retryAfterSeconds);
    }

    const completed = await this.unitOfWork.withTenant(
      { organizationId: claims.organizationId, userId: claims.userId },
      () => this.completeSignIn(input, claims, ipMasked),
    );

    const { session, kind, account, organization } = completed;

    this.logger.info(
      {
        event: SECURITY_EVENTS.signInSucceeded,
        outcome: 'session_opened',
        mfa: kind,
        userId: claims.userId,
        organizationId: claims.organizationId,
        sessionId: session.sessionId,
        ipMasked,
      },
      'session opened after the second factor',
    );

    return {
      status: 'authenticated',
      session,
      user: {
        id: account.id,
        email: account.email,
        locale: account.locale,
        timezone: account.timezone,
      },
      organization,
    };
  }

  private async completeSignIn(
    input: VerifySecondFactorInput,
    claims: MfaPendingTokenClaims,
    ipMasked: string,
  ): Promise<CompletedSignIn> {
    const account = await this.requireUsableAccount(claims.userId, ipMasked);
    const kind = await this.spendSecondFactor(input, claims, ipMasked);
    // Resolved before the session is written rather than after it, so the one read that can find a
    // deactivated tenant happens while nothing has been written yet.
    const organization = await this.describeOrganization();

    // Before the session row, so a failure to spend the token leaves no session at all.
    await this.mfaTokens.revoke(claims);

    const session = await this.issueSession.execute({
      userId: claims.userId,
      permissionsVersion: account.permissionsVersion,
      client: input.client,
    });

    // Inside the transaction, exactly as `LoginUseCase` writes its own: an action nobody could
    // write down did not happen, and a rejected trail write takes the session with it.
    await this.audit.record({
      action: 'session.signed_in',
      actor: {
        userId: claims.userId,
        organizationId: claims.organizationId,
        ipAddress: input.client.ipAddress,
      },
      target: { type: 'SESSION', id: session.sessionId },
      // The one fact that separates this entry from an ordinary sign-in: which proof opened it. A
      // sign-in that spent a recovery code also leaves `user.mfa_recovery_code_used` beside this
      // row (`ConsumeRecoveryCodeUseCase`), and the two answer different questions — "how did this
      // session start" and "which of the ten codes is gone".
      after: { mfa: kind },
      requestId: undefined,
    });

    return { session, kind, account, organization };
  }

  /**
   * The organization the scope is pinned to, read back from the tenant root.
   *
   * The same reasoning `IssueSessionUseCase.organizationOf` gives for reading it rather than taking
   * it as an argument: the response names an organization, and a name carried in from the token
   * would be a second source of truth next to the one the transaction is actually pinned to.
   */
  private async describeOrganization(): Promise<AuthenticatedLogin['organization']> {
    const organization = await this.organizations.findCurrent();

    if (organization === null) {
      throw new Error('verify-second-factor: the tenant scope names an organization that is gone');
    }

    return { id: organization.id, name: organization.name, slug: organization.slug };
  }

  /**
   * The account as it stands **now**, or the refusal the password step would have given.
   *
   * Read before the factor is judged so that a suspension never costs somebody one of their ten
   * recovery codes: spending a code for a sign-in that was going to be refused anyway would be a
   * charge for nothing.
   */
  private async requireUsableAccount(userId: string, ipMasked: string): Promise<UserRecord> {
    const account = await this.users.findById(userId);

    if (account === null) {
      this.refuse('account_unusable', ipMasked);

      throw new UnauthenticatedError('invalid_credentials');
    }

    if (account.status !== 'ACTIVE') {
      this.refuse('account_unusable', ipMasked);

      // `SUSPENDED` gets its own code and everything else does not — the same split
      // `LoginUseCase.refuseInactive` makes, reachable here for the same reason it is reachable
      // there: a password has already verified, so this is not a second answer to "does this
      // address exist".
      throw account.status === 'SUSPENDED'
        ? new AccountRefusedError('account_suspended')
        : new UnauthenticatedError('invalid_credentials');
    }

    return account;
  }

  /** Verifies and consumes whichever proof was presented, or throws the refusal it earned. */
  private async spendSecondFactor(
    input: VerifySecondFactorInput,
    claims: MfaPendingTokenClaims,
    ipMasked: string,
  ): Promise<SecondFactorKind> {
    if (!TOTP_CODE_PATTERN.test(input.code)) {
      // Refusals of this branch — including the shape check that precedes any Argon2id work — are
      // raised by `ConsumeRecoveryCodeUseCase` as `RecoveryCodeInvalidError`, which is the 401 the
      // contract declares for exactly this step, and logged by it as `recovery_code_refused`.
      await this.consumeRecoveryCode.execute({
        actor: { organizationId: claims.organizationId, userId: claims.userId },
        code: input.code,
        ipAddress: input.client.ipAddress,
      });

      return 'recovery_code';
    }

    await this.spendTotpCode(input.code, claims, ipMasked);

    return 'totp';
  }

  private async spendTotpCode(
    code: string,
    claims: MfaPendingTokenClaims,
    ipMasked: string,
  ): Promise<void> {
    const state = await this.enrollment.find(claims.userId);

    if (state === null || state.enabledAt === null) {
      // 2FA was turned off between the two steps, or the row is gone. No secret means no code can
      // match, and saying so specifically would answer a question about another account's state.
      this.refuse('not_enrolled', ipMasked);

      throw new MfaInvalidCodeError();
    }

    const verification = this.totp.verify({
      base32Secret: this.decryptSecret(state.secretEnc, claims),
      code,
      at: this.clock.now(),
      sinceCounter: state.lastCounter,
    });

    if (!verification.accepted) {
      this.refuse(verification.replayed ? 'replayed' : 'wrong_code', ipMasked);

      throw verification.replayed ? new MfaCodeReplayedError() : new MfaInvalidCodeError();
    }

    // The conditional write is what actually decides a race: two requests presenting the same code
    // in the same thirty seconds both pass `verify`, and only one of them advances the counter.
    const advanced = await this.enrollment.advanceCounter(claims.userId, verification.counter);

    if (!advanced) {
      this.refuse('replayed', ipMasked);

      throw new MfaCodeReplayedError();
    }
  }

  /**
   * The secret, decrypted for the length of one comparison and handed nowhere else.
   *
   * A decryption that throws is not a wrong code — it means the running `APP_ENCRYPTION_KEY` cannot
   * read the stored column at all, which locks out every account with 2FA enabled. The identical
   * handling `ConfirmTotpUseCase` and `DisableTotpUseCase` give the same failure: `error` level,
   * its own security event, and `503` rather than a refusal counted among wrong codes.
   */
  private decryptSecret(secretEnc: string, claims: MfaPendingTokenClaims): string {
    try {
      const decrypted = this.fields.decrypt(secretEnc);

      // `FieldEncryptionPort.decrypt` never returns `null` for a non-null input — see its own
      // contract. Guarded rather than asserted so a port that ever broke that promise fails here,
      // loudly and in one place, instead of handing an empty secret to the verifier. The same words
      // stand over the same guard in `confirm-totp`, `disable-totp` and
      // `regenerate-recovery-codes`: four identical places, and one of them reading differently is
      // how the next reader starts looking for a difference that is not there.
      if (decrypted === null) {
        throw new Error('field-encryption: decrypted a non-null ciphertext to null');
      }

      return decrypted;
    } catch (cause) {
      this.logger.error(
        {
          event: SECURITY_EVENTS.totpSecretUndecryptable,
          organizationId: claims.organizationId,
          userId: claims.userId,
        },
        'TOTP secret column could not be decrypted with the running encryption key',
      );

      throw new ServiceUnavailableError({ dependency: 'field-encryption' }, cause);
    }
  }

  /**
   * One line per refused second factor, with the masked source and never the code.
   *
   * Two event names rather than one, because they mean different things to whoever reads them:
   * a refused *code* is the enrolment-time event this catalog entry already anticipates
   * (`totpVerificationFailed`, "once STORY-013-03 wires the second-factor step, at sign-in"), while
   * a token that cannot be used or an account that may not sign in are refusals of the *sign-in*
   * and belong beside the ones `LoginUseCase` writes.
   */
  private refuse(outcome: SecondFactorRefusal, ipMasked: string): void {
    const event =
      outcome === 'wrong_code' || outcome === 'replayed' || outcome === 'not_enrolled'
        ? SECURITY_EVENTS.totpVerificationFailed
        : SECURITY_EVENTS.signInFailed;

    this.logger.warn({ event, outcome, ipMasked }, 'second factor refused');
  }
}
