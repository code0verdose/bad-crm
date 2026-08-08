/**
 * Encrypting one field at rest, under the installation's own key.
 *
 * **Not the vault.** The vault is end-to-end encrypted and the server holds no key for it
 * (invariant 3); this is the other category — data the server legitimately reads to do its job, kept
 * out of a database dump: API keys of AI providers, SMTP passwords, TOTP secrets, and the emergency
 * contact of an employee (`CLAUDE.md`, «Что шифруется»).
 *
 * The format is `v1:<iv>:<tag>:<ciphertext>`, and the version prefix is the point: rotating
 * `APP_ENCRYPTION_KEY` means writing `v2:` and being able to read `v1:` for as long as one row still
 * carries it. A format without one is a key that cannot be rotated without downtime.
 *
 * Decryption happens **at the moment of use** and the result is never put in a module variable,
 * never logged, and never returned by an API that did not ask for exactly it.
 */
export interface FieldEncryptionPort {
  /** `null` in, `null` out: an absent value is absent rather than an encrypted empty string. */
  encrypt(plaintext: string | null): string | null;
  /**
   * Reads a value back.
   *
   * @throws when the stored string is not in a format this key can read — a truncated column, a
   * value written under a key that is gone. Not `null`: «cannot decrypt» and «there was nothing
   * here» are different facts, and folding them together loses data silently.
   */
  decrypt(ciphertext: string | null): string | null;
}
