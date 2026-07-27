import { z } from 'zod';

/** Minimum length, aligned with the vault master password policy (docs/security/e2ee-design.md). */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Upper bound, so a multi-megabyte "password" cannot turn an Argon2id hash into a denial of
 * service. Argon2id has no 72-byte truncation problem, so the limit can stay generous.
 */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * User password.
 *
 * Deliberately **not** trimmed and not case-folded: a password is a byte sequence chosen by a
 * human, and silently rewriting it makes it unreproducible in another client. Strength scoring
 * (`zxcvbn`, score >= 3, top-100k blocklist) belongs to the auth epic and lives next to the
 * use-case that can also rate-limit it — it is not a static schema concern.
 */
export const passwordSchema = z
  .string({ error: 'validation.password.invalid' })
  .min(PASSWORD_MIN_LENGTH, { error: 'validation.password.too_short' })
  .max(PASSWORD_MAX_LENGTH, { error: 'validation.password.too_long' });

export type Password = z.infer<typeof passwordSchema>;
