/** One freshly minted recovery code, in both forms it needs to exist in. */
export interface MintedRecoveryCode {
  /** Shown to the person **once**, in the response body, and never stored. */
  readonly plaintext: string;
  /** What actually goes into `mfa_recovery_codes.code_hash` — argon2id, through `PasswordHasherPort`. */
  readonly hash: string;
}

/**
 * Mints a batch of recovery codes, drawn from `RECOVERY_CODE_ALPHABET` by a CSPRNG.
 *
 * A port of its own, on the same reasoning `ResetTokenPort` and `RefreshTokenPort` are: drawing
 * randomness is an infrastructure decision (`node:crypto`), and a use-case that called `randomInt`
 * directly could not be unit-tested without exercising the real generator — the property this suite
 * actually needs to assert is "ten *distinct* codes came back", not "the generator was seeded
 * correctly".
 *
 * Hashing happens **inside** the port rather than being a second call the use-case makes, because the
 * two are inseparable in practice: nothing may hold a plaintext code without immediately producing the
 * digest that is the only thing ever written down, and splitting them into two calls would be a place
 * a future caller could keep the plaintext a moment longer than it needs to exist.
 */
export interface RecoveryCodeGeneratorPort {
  generateBatch(count: number): Promise<readonly MintedRecoveryCode[]>;
}
