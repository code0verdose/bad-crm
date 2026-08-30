import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type RecoveryCodeMatcher } from '@/application/identity/use-cases/recovery-code-matcher.use-case.js';
import { type RecoveryCodeRepositoryPort } from '@/application/identity/ports/recovery-code-repository.port.js';
import {
  type UserCredentialRecord,
  type UserRepositoryPort,
} from '@/application/identity/ports/user-repository.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type MailDispatchPort } from '@/application/platform/ports/mail-dispatch.port.js';
import { type MetricsPort } from '@/application/platform/ports/metrics.port.js';
import { type RateLimitPort } from '@/application/platform/ports/rate-limit.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { renderMfaChangedMail } from '@/domain/identity/mfa-changed-mail.util.js';
import {
  isWellFormedRecoveryCode,
  normalizeRecoveryCode,
} from '@/domain/identity/recovery-code.value.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import { RateLimitedError, RecoveryCodeInvalidError } from '@/domain/shared/errors/app.errors.js';

export interface ConsumeRecoveryCodeInput {
  readonly actor: { readonly organizationId: string; readonly userId: string };
  readonly code: string;
  /** The caller's address, for the audit trail — `undefined` off a socket with no peer address. */
  readonly ipAddress: string | undefined;
}

/**
 * Spending exactly one recovery code — the atomic building block STORY-013-02 asks for.
 *
 * **Reachable since 2026-08-13**, through the one caller it was written for:
 * `VerifySecondFactorUseCase` takes the recovery-code branch of `POST /auth/2fa/verify` and delegates
 * here (`verify-second-factor.use-case.ts`, wired in `container.factory.ts`). Until then nothing
 * called `execute`, deliberately — spending a code with no pending sign-in to attach the resulting
 * session to would have been a hole rather than a convenience, which is why the caller and this
 * class shipped one story apart.
 *
 * ## The match runs a fixed number of Argon2id verifications, never fewer, never zero
 *
 * Argon2id salts every hash independently (`csprng-recovery-code-generator.adapter.ts`), so the same
 * plaintext code produces a different `code_hash` on every row — there is no index that turns
 * "does this code belong to this account" into an equality lookup. The loop therefore tries every
 * unused row in turn (`RecoveryCodeRepositoryPort.listUnused`), on the identical reasoning
 * `LoginUseCase.verifyAll` gives for trying every password candidate: an early exit on the first
 * match would make the elapsed time depend on *where in the list* the right code happens to sit.
 *
 * **The number of verifications itself is fixed at `RECOVERY_CODE_COUNT` (ten), padded with dummy
 * comparisons when fewer real rows remain.** A loop that ran once per *actual* candidate would still
 * leak something through elapsed time even without an early exit: how many unused rows exist for this
 * account, because a batch down to its last code runs one verification and a fresh batch runs ten.
 * That is precisely the number `POST /auth/2fa/recovery-codes` (`ReadRecoveryCodeStatusQuery`) is
 * gated behind a session for — an unauthenticated caller at this endpoint must not be able to read it
 * back through a stopwatch. Padding to a constant ten makes "no such code", "wrong code" and "one
 * code left" cost the identical ten Argon2id verifications as "ten codes left" — never fewer, and
 * never a shortcut that scales down with how spent the batch already is.
 *
 * **A code that does not even have the right shape is refused before any verification runs.**
 * `isWellFormedRecoveryCode` checks length and alphabet only — public facts documented in
 * `recovery-code.value.ts`, not anything about which codes this account actually holds — so rejecting
 * on it costs nothing to distinguish and reveals nothing an attacker could not already read off the
 * setup screen. This is a load-shedding measure, not a timing decision: without it, an arbitrary
 * string of any shape costs the full ten verifications the same as a well-formed guess.
 *
 * ## What a refusal leaves behind, and what a run of them does
 *
 * Every refused code increments `mfa_recovery_failed_total` (`MetricsPort`) and writes a
 * `recovery_code_refused` line. The refusal that spends the last of the `mfa_recovery_consume_attempt`
 * budget additionally files **one** `user.mfa_recovery_locked_out` row in the trail — the aggregated
 * record STORY-013-02 acceptance 10 asks for. It is filed there, on the transition, rather than on
 * every subsequent 429, because every attempt after that one is turned away by the limiter before a
 * code is compared: a row per turned-away attempt would be the limiter's own counter written into
 * the trail, and would bury the runs the entry exists to surface.
 *
 * ## Why the winner is still decided by the database, not by the loop
 *
 * Two requests can both resolve the *same* row as the match — they are running the identical
 * comparison against the identical stored hash — and only `RecoveryCodeRepositoryPort.markUsed`'s
 * conditional `UPDATE ... WHERE used_at IS NULL` decides which of them, if either, actually spends
 * it (STORY-013-02, acceptance 3; proven under real concurrency in
 * `test/integration/db/mfa-recovery-code-race.test.ts`). A loop that trusted its own comparison to
 * mean "this code is now spent" would let both winners open a session from the same code.
 *
 * ## The match itself lives in `RecoveryCodeMatcher`
 *
 * STORY-013-04's `DisableTotpUseCase` needs the identical timing-safe match — a recovery code is one
 * of the two proofs `POST /auth/2fa/disable` accepts — but must not spend it before a second,
 * independent proof (the password) is also known to be correct. That ordering cannot be built out of
 * a method that always matches *and* spends in one step, so the fixed-cost loop moved to
 * `RecoveryCodeMatcher` and this class became one of its two callers instead of the loop's only
 * owner. `markUsed` itself was already shared before this split; the split closes the other half —
 * two use-cases no longer risk two drifting implementations of "how many verifications, in what
 * order" for the one loop whose entire point is that the count never varies.
 */
export class ConsumeRecoveryCodeUseCase {
  constructor(
    private readonly matcher: RecoveryCodeMatcher,
    private readonly codes: RecoveryCodeRepositoryPort,
    private readonly users: UserRepositoryPort,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly rateLimit: RateLimitPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly audit: AuditLoggerPort,
    private readonly metrics: MetricsPort,
    private readonly mailDispatcher: MailDispatchPort,
    private readonly appUrl: string,
  ) {}

  /** The id of the row that was spent, or throws `RecoveryCodeInvalidError`/`RateLimitedError`. */
  async execute(input: ConsumeRecoveryCodeInput): Promise<string> {
    const decision = await this.rateLimit.consume('mfa_recovery_consume_attempt', {
      userId: input.actor.userId,
      ipAddress: input.ipAddress,
    });

    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);

    const normalized = normalizeRecoveryCode(input.code);

    // Refused before any Argon2id verification runs — shape and alphabet are public facts this
    // costs nothing to check and reveals nothing account-specific (see the class docstring).
    const spent = isWellFormedRecoveryCode(normalized)
      ? await this.unitOfWork.withTenant(input.actor, () =>
          this.spend(input.actor, normalized, input.ipAddress),
        )
      : null;

    if (spent === null) {
      this.metrics.incrementMfaRecoveryFailed();
      this.logger.warn(
        {
          event: SECURITY_EVENTS.recoveryCodeRefused,
          organizationId: input.actor.organizationId,
          userId: input.actor.userId,
        },
        'recovery code refused',
      );

      // `remaining === 0` is the last attempt this budget allows: the run ends here, and every
      // further guess is turned away by the limiter above without reaching a comparison. See the
      // class docstring, «What a refusal leaves behind».
      if (decision.remaining === 0) await this.recordLockout(input);

      throw new RecoveryCodeInvalidError();
    }

    await this.rateLimit.reset('mfa_recovery_consume_attempt', {
      userId: input.actor.userId,
      ipAddress: input.ipAddress,
    });

    // After the transaction that spent the row has committed, and never awaited: a notice that
    // could not be delivered must not undo a sign-in that already happened (`MailDispatchPort`).
    this.notify(input, spent.credential);

    return spent.id;
  }

  /** The aggregated trail entry for a run of refusals — one per exhausted budget, not per attempt. */
  private async recordLockout(input: ConsumeRecoveryCodeInput): Promise<void> {
    await this.unitOfWork.withTenant(input.actor, () =>
      this.audit.record({
        action: 'user.mfa_recovery_locked_out',
        actor: {
          userId: input.actor.userId,
          organizationId: input.actor.organizationId,
          ipAddress: input.ipAddress,
        },
        target: { type: 'USER', id: input.actor.userId },
        // Which budget was burnt, and nothing else: not the code, not its digest, and not how many
        // unused codes remain — the number the fixed-cost match refuses to leak through timing.
        after: { policy: 'mfa_recovery_consume_attempt' },
        requestId: undefined,
      }),
    );
  }

  /**
   * "A recovery code was used to sign in", best-effort and after the commit.
   *
   * `credential` is `null` when the account row vanished between the match and the read — the same
   * window `UserRepositoryPort` documents elsewhere. There is then no address to write to, and the
   * sign-in stands regardless: the row is spent and committed by the time this runs.
   */
  private notify(input: ConsumeRecoveryCodeInput, credential: UserCredentialRecord | null): void {
    if (credential === null) return;

    this.mailDispatcher.dispatch(
      {
        to: credential.email,
        ...renderMfaChangedMail({
          locale: credential.locale,
          appUrl: this.appUrl,
          reason: 'recovery_code_used',
        }),
      },
      {
        event: SECURITY_EVENTS.recoveryCodeUsed,
        organizationId: input.actor.organizationId,
        userId: input.actor.userId,
      },
    );
  }

  private async spend(
    actor: ConsumeRecoveryCodeInput['actor'],
    normalizedCode: string,
    ipAddress: string | undefined,
  ): Promise<{ readonly id: string; readonly credential: UserCredentialRecord | null } | null> {
    const matchId = await this.matcher.match(actor.userId, normalizedCode);

    if (matchId === null) return null;

    const won = await this.codes.markUsed(actor.userId, matchId, this.clock.now());

    // Lost the race to another request resolving the same row — answered exactly like "no match",
    // never a second, more specific refusal: telling the two apart would confirm that the code was
    // genuinely valid a moment ago.
    if (!won) return null;

    await this.audit.record({
      action: 'user.mfa_recovery_code_used',
      actor: { userId: actor.userId, organizationId: actor.organizationId, ipAddress },
      target: { type: 'USER', id: actor.userId },
      requestId: undefined,
    });

    // Read inside the tenant scope, dispatched outside it: the address the notice goes to is tenant
    // data like any other, and `guardedClient` refuses a read taken after the scope has closed.
    return { id: matchId, credential: await this.users.findCredential(actor.userId) };
  }
}
