import { z } from 'zod';

import { isWeakPassword } from './weak-password.util.js';

/** Minimum length, aligned with the vault master password policy (docs/security/e2ee-design.md). */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Upper bound, so a multi-megabyte "password" cannot turn an Argon2id hash into a denial of
 * service. Argon2id has no 72-byte truncation problem, so the limit can stay generous.
 */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * A password somebody **presents** — the bounds, and nothing about strength.
 *
 * Deliberately **not** trimmed and not case-folded: a password is a byte sequence chosen by a
 * human, and silently rewriting it makes it unreproducible in another client.
 *
 * Deliberately **not** judged either. This schema sits on `currentPassword` fields and on sign-in:
 * a rule that refused to *send* a password chosen before the policy would lock its owner out of
 * the very form that lets them replace it. The judgement is `newPasswordSchema` below, for the
 * fields that *set* one. (Until 2026-09-06 this comment promised `zxcvbn` and a top-100k list
 * «next to the use-case»; what shipped is `isWeakPassword`, a shape check, and it is now here.)
 */
export const passwordSchema = z
  .string({ error: 'validation.password.invalid' })
  .min(PASSWORD_MIN_LENGTH, { error: 'validation.password.too_short' })
  .max(PASSWORD_MAX_LENGTH, { error: 'validation.password.too_long' });

export type Password = z.infer<typeof passwordSchema>;

/** i18n key of the refusal `newPasswordSchema` attaches to the field. */
export const WEAK_PASSWORD_MESSAGE_KEY = 'validation.password.weak';

/**
 * A password somebody is **choosing** — the bounds, then the shape check the server applies.
 *
 * The refinement runs only once the bounds have passed (`when` gates a Zod 4 check on the issues
 * already raised), so a short password is «too short» and not «too short and weak»: one mistake,
 * one sentence. The server's use-cases call `isWeakPassword` themselves rather than parsing with this
 * schema, because they apply it *after* the rate limit and the check is where the budget is spent;
 * both sides read the same function, so the verdicts are the same by construction.
 */
export const newPasswordSchema = passwordSchema.refine((password) => !isWeakPassword(password), {
  error: WEAK_PASSWORD_MESSAGE_KEY,
  when: (payload) => payload.issues.length === 0,
});
