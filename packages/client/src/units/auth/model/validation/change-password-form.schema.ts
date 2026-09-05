import { SharedValidation } from '@bad-crm/shared';
import { z } from 'zod';

/** i18n key of the refusal the contract states in as many words: the new password equals the old. */
export const PASSWORD_UNCHANGED_MESSAGE_KEY = 'validation.password.unchanged';

/** i18n key of the cross-field failure — the two copies of the new password differ. */
export const PASSWORD_CONFIRMATION_MESSAGE_KEY = 'validation.password.mismatch';

/**
 * What the change-password form asks for: the password one has, the password one wants, and that
 * password again.
 *
 * **Three fields, two of which travel.** `ChangePasswordRequest` has `currentPassword` and
 * `newPassword`; the confirmation exists for the same reason it exists on the reset screen — the
 * input is masked, the person cannot read back what they typed, and a typo would leave them with a
 * password nobody knows. Here the consequence is milder than on the reset screen (the old password
 * still works, so they are not locked out) but the cost of catching it is one field.
 *
 * **The current password is checked for presence only.** A length rule on it would refuse to *send*
 * a password chosen before the current policy — which is exactly the password somebody with an old
 * account is trying to replace. The new one gets `SharedValidation.passwordSchema`, the same schema
 * the server applies, because this is the screen that *sets* a password.
 *
 * **Equality with the current password is refused here as well as there.** The server answers
 * `422 validation_failed` for it, so nothing is lost by letting it through — except a round trip and
 * one of a small number of attempts against a rate limiter this operation shares with sign-in.
 *
 * Both refinements point at a field rather than at the object, so `@mantine/form` renders each under
 * the input somebody has to fix: an error attached to the form has no `aria-describedby` to belong
 * to (`rules/errors-and-toasts.mdc` §4, `rules/a11y.mdc` §18).
 *
 * The strength meter is **not** part of this schema and deliberately cannot be: there is no strength
 * policy on the server, and a client that refused what the server accepts would be inventing one.
 */
export const changePasswordFormSchema = z
  .object({
    currentPassword: z.string().min(1, { error: 'validation.password.required' }),
    newPassword: SharedValidation.passwordSchema,
    // No policy of its own: it is right when it equals the field above and wrong otherwise, and a
    // second «too short» under it would be one mistake reported twice.
    confirmPassword: z.string(),
  })
  .refine((values) => values.newPassword !== values.currentPassword, {
    error: PASSWORD_UNCHANGED_MESSAGE_KEY,
    path: ['newPassword'],
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    error: PASSWORD_CONFIRMATION_MESSAGE_KEY,
    path: ['confirmPassword'],
  });

export type ChangePasswordFormValues = z.infer<typeof changePasswordFormSchema>;
