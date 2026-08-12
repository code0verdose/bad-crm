import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import { type RecoveryCodeRepositoryPort } from '@/application/identity/ports/recovery-code-repository.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type RateLimitPort } from '@/application/platform/ports/rate-limit.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import {
  isWellFormedRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
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
 * Spending exactly one recovery code — the atomic building block STORY-013-02 asks for, and the
 * surface `POST /auth/2fa/verify` will call once STORY-013-03 wires the second-factor sign-in step to
 * it. **Not itself reachable from any route in this delta**: nothing in `route-registry.factory.ts`
 * calls `execute`, because doing so would open a way to spend a recovery code without a pending
 * sign-in to attach the resulting session to — the part STORY-013-03 owns.
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
 * ## Why the winner is still decided by the database, not by the loop
 *
 * Two requests can both resolve the *same* row as the match — they are running the identical
 * comparison against the identical stored hash — and only `RecoveryCodeRepositoryPort.markUsed`'s
 * conditional `UPDATE ... WHERE used_at IS NULL` decides which of them, if either, actually spends
 * it (STORY-013-02, acceptance 3; proven under real concurrency in
 * `test/integration/db/mfa-recovery-code-race.test.ts`). A loop that trusted its own comparison to
 * mean "this code is now spent" would let both winners open a session from the same code.
 */
export class ConsumeRecoveryCodeUseCase {
  constructor(
    private readonly codes: RecoveryCodeRepositoryPort,
    private readonly hasher: PasswordHasherPort,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly rateLimit: RateLimitPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  /** The id of the row that was spent, or throws `RecoveryCodeInvalidError`/`RateLimitedError`. */
  async execute(input: ConsumeRecoveryCodeInput): Promise<string> {
    const decision = await this.rateLimit.consume('mfa_recovery_consume_attempt', {
      userId: input.actor.userId,
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
      this.logger.warn(
        {
          event: SECURITY_EVENTS.recoveryCodeRefused,
          organizationId: input.actor.organizationId,
          userId: input.actor.userId,
        },
        'recovery code refused',
      );

      throw new RecoveryCodeInvalidError();
    }

    await this.rateLimit.reset('mfa_recovery_consume_attempt', { userId: input.actor.userId });

    return spent;
  }

  private async spend(
    actor: ConsumeRecoveryCodeInput['actor'],
    normalizedCode: string,
    ipAddress: string | undefined,
  ): Promise<string | null> {
    const candidates = await this.codes.listUnused(actor.userId);

    const matchId = await this.match(candidates, normalizedCode);

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

    return matchId;
  }

  private async match(
    candidates: readonly { readonly id: string; readonly codeHash: string }[],
    normalizedCode: string,
  ): Promise<string | null> {
    let matchId: string | null = null;

    // Fixed at RECOVERY_CODE_COUNT slots, never fewer — the timing reason this class's docstring
    // gives. Sequential and without an early exit even once a match is found, so the elapsed time
    // never depends on *where* in the list the right code sits either.
    const slots = Math.max(candidates.length, RECOVERY_CODE_COUNT);

    for (let index = 0; index < slots; index += 1) {
      const candidate = candidates[index];

      if (candidate === undefined) {
        // Padding: no real row left at this slot, verified against the dummy digest all the same.
        await this.hasher.verify(this.hasher.dummyHash, normalizedCode);

        continue;
      }

      if (await this.hasher.verify(candidate.codeHash, normalizedCode)) matchId = candidate.id;
    }

    return matchId;
  }
}
