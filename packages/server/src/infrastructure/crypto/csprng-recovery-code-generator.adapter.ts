import { randomInt } from 'node:crypto';

import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import {
  type MintedRecoveryCode,
  type RecoveryCodeGeneratorPort,
} from '@/application/identity/ports/recovery-code-generator.port.js';
import {
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_LENGTH,
} from '@/domain/identity/recovery-code.value.js';

/**
 * Recovery codes: `node:crypto.randomInt` per character, argon2id per code through the same
 * `PasswordHasherPort` a password uses.
 *
 * **`randomInt`, not `Math.random()` and not a byte modulo.** `randomInt(max)` is CSPRNG-backed and
 * rejection-sampled internally — it draws again on any value that would introduce modulo bias, so
 * every character of `RECOVERY_CODE_ALPHABET` is exactly as likely as every other one
 * (`rules/hexagonal-backend.mdc` forbids `Math.random()` in `domain`/`application`; this is the one
 * place in the codebase whose entire job is to be the infrastructure that rule points to).
 *
 * **argon2id and not SHA-256.** A recovery code is drawn from a smaller alphabet than a refresh or
 * reset token and is meant to be *read and typed* rather than pasted from a link, which trades away
 * some of the entropy `ResetTokenPort`'s SHA-256 choice relies on
 * (`RECOVERY_CODE_ENTROPY_BITS` ≈ 49.4 bits, against 256 for a minted reset token). The password
 * hasher's cost is what keeps an offline guess against a stolen `mfa_recovery_codes` dump expensive
 * despite the smaller space — the same reasoning `docs/architecture/stack.md` already applies to
 * passwords, and the reason STORY-013-02 names argon2id explicitly rather than leaving the choice
 * open.
 */
export class CsprngRecoveryCodeGenerator implements RecoveryCodeGeneratorPort {
  constructor(private readonly hasher: PasswordHasherPort) {}

  async generateBatch(count: number): Promise<readonly MintedRecoveryCode[]> {
    const codes: MintedRecoveryCode[] = [];

    // Sequential rather than `Promise.all`: each `hash` call is ~30-60 ms of Argon2id on the libuv
    // threadpool (`argon2-password-hasher.adapter.ts`), and ten of them in parallel would spend the
    // installation's whole hashing budget on one enrolment at once — the same reasoning that keeps
    // `LoginUseCase.verifyAll` sequential rather than parallel.
    for (let index = 0; index < count; index += 1) {
      const plaintext = this.drawOne();
      const hash = await this.hasher.hash(plaintext);

      codes.push({ plaintext, hash });
    }

    return codes;
  }

  private drawOne(): string {
    let code = '';

    for (let index = 0; index < RECOVERY_CODE_LENGTH; index += 1) {
      code += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
    }

    return code;
  }
}
