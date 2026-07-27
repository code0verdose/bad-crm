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
  // The same keys one level up: `logger.info({ password })` has no parent object for `*.` to match.
  'password',
  'token',
  'refreshToken',
  'apiKey',
  'apiKeyEnc',
  'secret',
  'otp',
  'recoveryCode',
];
