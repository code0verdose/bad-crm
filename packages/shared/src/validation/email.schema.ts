import { z } from 'zod';

/**
 * Email address, normalised before it is validated.
 *
 * Normalisation is part of the schema, not of the caller: an address that differs only by case or
 * by surrounding whitespace is the same address, and the uniqueness constraint on
 * `User.email` has to see the same string every time (rules/zod-validation.mdc, rule 8).
 *
 * Messages are i18n keys, never ready-made sentences (rules/i18n.mdc).
 */
export const emailSchema = z
  .string({ error: 'validation.email.invalid' })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'validation.email.invalid' }));

export type Email = z.infer<typeof emailSchema>;
