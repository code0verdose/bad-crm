import {
  type MintedRecoveryCode,
  type RecoveryCodeGeneratorPort,
} from '@/application/identity/ports/recovery-code-generator.port.js';
import { type RecoveryCodeRepositoryPort } from '@/application/identity/ports/recovery-code-repository.port.js';
import { RECOVERY_CODE_COUNT } from '@/domain/identity/recovery-code.value.js';

/**
 * Issuing a fresh batch of ten recovery codes for one account, split into a CPU-bound half and an
 * I/O-bound half deliberately — see `mint` and `persist` below.
 *
 * `ConfirmTotpUseCase` and `RegenerateRecoveryCodesUseCase` each call `mint` **before** opening their
 * transaction and `persist` **inside** it, immediately after the write that makes issuing a batch the
 * right thing to do (`commitEnrollment`, or deleting the previous batch) — 2FA becoming enabled and
 * recovery codes existing for it are one fact, not two (STORY-013-01, acceptance 2; STORY-013-02,
 * acceptance 7), so the two writes still have to commit or roll back together. Neither caller may
 * hold the plaintext batch a moment longer than returning it to its own caller — nothing in this
 * class logs it, and nothing keeps a reference to it after `persist` returns.
 */
export class GenerateRecoveryCodesUseCase {
  constructor(
    private readonly codes: RecoveryCodeRepositoryPort,
    private readonly generator: RecoveryCodeGeneratorPort,
  ) {}

  /**
   * Draws ten codes and hashes every one with Argon2id — no database I/O, and deliberately called
   * before any transaction opens.
   *
   * Ten Argon2id hashes measure in the hundreds of milliseconds even on modest hardware — cheap next
   * to a login, but not cheap to hold an interactive transaction's row locks and its five-second
   * statement budget open for. Minting first and handing the caller finished hashes to `persist`
   * means the transaction itself only ever does the write (`createMany`), never the hashing.
   */
  mint(): Promise<readonly MintedRecoveryCode[]> {
    return this.generator.generateBatch(RECOVERY_CODE_COUNT);
  }

  /**
   * Writes an already-minted batch — the one database call, meant to run inside the caller's
   * transaction.
   *
   * The ten plaintext codes, in the order they were minted — shown once, by the caller's caller.
   */
  async persist(userId: string, minted: readonly MintedRecoveryCode[]): Promise<readonly string[]> {
    await this.codes.createMany(
      userId,
      minted.map((code) => code.hash),
    );

    return minted.map((code) => code.plaintext);
  }
}
