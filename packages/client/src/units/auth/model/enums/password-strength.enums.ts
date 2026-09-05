/**
 * How a password reads to the meter beside the field — four steps, and none of them is a verdict.
 *
 * The product has no strength policy: `SharedValidation.passwordSchema` is a length range and
 * nothing else, and the server applies exactly that. The meter is therefore advice, and the four
 * words are chosen to sound like advice; a level never refuses a submission
 * (`change-password-form.schema.ts` validates length and agreement, and does not look at this).
 */
export const PASSWORD_STRENGTHS = ['weak', 'fair', 'good', 'strong'] as const;

export type PasswordStrength = (typeof PASSWORD_STRENGTHS)[number];

/**
 * The sentence for each level — a **whole** sentence per level, not «Password strength: » plus a
 * word.
 *
 * Assembling one from two catalogue entries is the composition `rules/i18n.mdc` §7 forbids, and it
 * would be wrong in Russian before it was wrong anywhere else: the adjective has to agree with the
 * noun it is glued to, and the glue is in the wrong file to know that.
 */
export const PASSWORD_STRENGTH_MESSAGE_KEY: Readonly<Record<PasswordStrength, string>> = {
  weak: 'security.password.strength.weak',
  fair: 'security.password.strength.fair',
  good: 'security.password.strength.good',
  strong: 'security.password.strength.strong',
};
