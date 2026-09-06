import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import {
  type RecoveryCodeCandidate,
  type RecoveryCodeRepositoryPort,
} from '@/application/identity/ports/recovery-code-repository.port.js';
import { RECOVERY_CODE_COUNT } from '@/domain/identity/recovery-code.value.js';

/**
 * Finding which unused recovery code, if any, a normalized candidate matches — the timing-safe half
 * of consuming one, kept apart from spending it.
 *
 * ## Why this is its own class and not a method on `ConsumeRecoveryCodeUseCase`
 *
 * `ConsumeRecoveryCodeUseCase` (STORY-013-02) has exactly one caller that needs "match and spend, as
 * one step": the second-factor sign-in this class's own docstring says it exists for. STORY-013-04's
 * `DisableTotpUseCase` needs the opposite shape — **match without spending**, because disabling 2FA
 * checks the password and the second-factor proof in parallel before either is judged (the pattern
 * `RegenerateRecoveryCodesUseCase.checkTotp` already uses for the TOTP half of the same problem), and
 * spending a code before the password is known to be right would burn it on a request that never
 * should have succeeded. There is no way to get that ordering out of a method that always spends,
 * short of exposing "match" and "spend" as two separately callable steps of the same object.
 *
 * The alternative — writing the timing-safe loop a second time inside `DisableTotpUseCase` — is
 * exactly what STORY-013-04 was told not to do ("не заводи вторую реализацию списания"): two copies
 * of a loop whose entire point is a fixed, unconditional cost drift the moment one of them is
 * touched and the other is not, and the drift is invisible to every test that only checks the
 * outcome. Factoring the loop here means `ConsumeRecoveryCodeUseCase` and `DisableTotpUseCase` share
 * one implementation of "how many Argon2id verifications does a match cost, and in what order" —
 * `RecoveryCodeRepositoryPort.markUsed`, the actual spend, was already shared before this class
 * existed; this closes the other half of the same gap.
 *
 * ## What it does not decide
 *
 * Spending — `RecoveryCodeRepositoryPort.markUsed` — is not called here. A caller that finds a match
 * still has to ask whether the code should be spent (a password also checked out, a pending sign-in
 * still exists to attach the resulting session to) before doing so; this class answers only "does
 * this code belong to this account and is it still unused", the one part of that question every
 * caller answers identically.
 *
 * ## Why the read and the comparisons are two calls and not one
 *
 * `listCandidates` needs a tenant scope; `compare` must not run inside one. Since STORY-013-06 every
 * Argon2id computation may first **wait** up to `AUTH_ARGON2_QUEUE_TIMEOUT_MS` for a slot, and this
 * loop pays that wait `RECOVERY_CODE_COUNT` times over, one queueing per verification. Held inside
 * an interactive transaction those waits are ten deadlines stacked inside one five-second budget
 * (`tenant.context.ts`, `DEFAULT_TIMEOUT_MS`), on a pinned pool connection: the transaction is
 * killed first and the caller is answered `500 internal_error` instead of the `503` with a
 * `Retry-After` the queue itself produced — the saturation regime turned into an outage of the whole
 * pool. Splitting the two lets a caller read its candidates in one short scope, run the comparisons
 * holding nothing, and open a second scope to write. It is the rule `tenant.context.ts` already
 * states for S3, SMTP and every other call that can block for seconds; the ceiling put Argon2id into
 * that class.
 */
export class RecoveryCodeMatcher {
  constructor(
    private readonly codes: RecoveryCodeRepositoryPort,
    private readonly hasher: PasswordHasherPort,
  ) {}

  /** Every unused row of the account — a tenant-scoped read, and the only I/O this class does. */
  async listCandidates(userId: string): Promise<readonly RecoveryCodeCandidate[]> {
    return await this.codes.listUnused(userId);
  }

  /**
   * The id of the unused row `normalizedCode` matches, or `null`.
   *
   * Runs a fixed `RECOVERY_CODE_COUNT` Argon2id verifications, padded with the dummy digest when
   * fewer real rows remain, sequential and without an early exit once a match is found — the timing
   * reasoning `ConsumeRecoveryCodeUseCase`'s own docstring gives at length: an early exit, or a count
   * that scaled with how many unused rows exist, would let elapsed time answer "how many recovery
   * codes does this account have left", which is exactly the number `GET /auth/2fa/recovery-codes` is
   * gated behind a session for.
   *
   * Takes an already-normalized, already-shape-checked code: `isWellFormedRecoveryCode` is a free
   * check on public facts about the format, and every caller pays it before this — the one Argon2id
   * cost this method exists to bound is not owed to a string that could never have been a code this
   * system issued.
   *
   * Takes the candidates rather than reading them, so that the loop can run outside the transaction
   * that read them — see the class docstring's last section.
   */
  async compare(
    candidates: readonly RecoveryCodeCandidate[],
    normalizedCode: string,
  ): Promise<string | null> {
    let matchId: string | null = null;
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
