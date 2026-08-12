/** What a redacted value is replaced with. Kept as a constant so tests assert the real string. */
export const REDACTED_PLACEHOLDER = '[Redacted]';

/**
 * Paths pino censors on every line — the list from CLAUDE.md, «Что нельзя логировать никогда».
 *
 * The wildcard entries (`*.password`) match at any depth, which is what makes the list survive
 * refactoring: a payload that moves from `body.password` to `input.credentials.password` stays
 * redacted.
 *
 * **This is a safety net, not a permission.** Deliberately logging a secret and relying on the
 * redaction to catch it is a defect: the net only knows the key names listed here, so a value
 * logged under a name nobody thought of travels to the aggregator in the clear. A new secret-
 * bearing field is added to this array in the same pull request that introduces it
 * (rules/observability.mdc, rule 4).
 */
export const REDACTED_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.refreshToken',
  '*.apiKey',
  '*.apiKeyEnc',
  '*.secret',
  '*.otp',
  '*.recoveryCode',
  /**
   * pino matches a **whole key**, never a substring of one, so `*.token` covers `token` and nothing
   * that merely ends in it. The three below are the names this codebase actually uses for the
   * values it must never write down — `accessToken` in the sign-in result, `refreshTokenHash` on a
   * session row, `passwordHash` on a user row — and none of them was covered.
   *
   * Nothing logs them today, which is exactly why the gap was invisible: the net is for the line
   * somebody adds while debugging a sign-in, and a net with a hole in the shape of the most likely
   * mistake is not a net.
   */
  '*.accessToken',
  '*.refreshTokenHash',
  '*.passwordHash',
  /**
   * The identical gap, found on the 2FA surface (EPIC-013): `*.secret` and `*.recoveryCode` cover a
   * key spelled exactly that way, and every call site in `identity/use-cases/*totp*` and
   * `*recovery-code*` spells it differently — `base32Secret` (the plaintext TOTP secret, everywhere
   * it exists in memory), `secretEnc` (the column that carries it at rest, redacted on the same
   * principle even though it is ciphertext — a value nothing should have a reason to write down), and
   * `recoveryCodes` (plural — the batch of ten plaintext codes `ConfirmTotpUseCase` and
   * `RegenerateRecoveryCodesUseCase` return). `mfa-recovery-code-structure.test.ts` pins that these
   * three are covered as the negative control for "a secret logged under this domain's own field
   * names, not the generic ones".
   */
  '*.base32Secret',
  '*.secretEnc',
  '*.recoveryCodes',
  // The same keys one level up: `logger.info({ password })` has no parent object for `*.` to match.
  'password',
  'token',
  'refreshToken',
  'apiKey',
  'apiKeyEnc',
  'secret',
  'otp',
  'recoveryCode',
  'accessToken',
  'refreshTokenHash',
  'passwordHash',
  'base32Secret',
  'secretEnc',
  'recoveryCodes',
];
