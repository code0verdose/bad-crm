import { SharedValidation } from '@bad-crm/shared';
import { z } from 'zod';

/** i18n key of the cross-field failure — the two fields do not agree (`rules/i18n.mdc` §1). */
export const PASSWORD_MISMATCH_MESSAGE_KEY = 'validation.password.mismatch';

/**
 * What the reset screen asks for: a new password, and the same password again.
 *
 * **The policy is enforced here, unlike on the sign-in form, and the difference is which password is
 * being typed.** Sign-in checks an *existing* password for presence only — enforcing a length there
 * would refuse a password chosen before the policy changed and would advertise the policy to
 * anybody with a login form. This screen *sets* one, so it is the screen the policy belongs to, and
 * `SharedValidation.passwordSchema` is the same one the server applies. A password refused here
 * costs a round trip; refused there it costs a round trip too — the token survives a 422 — so this
 * is about telling the person now rather than in a second.
 *
 * **The confirmation field is not ceremony.** This is the one form in the product where the input is
 * masked, the person cannot read back what they typed, and a typo is unrecoverable in the ordinary
 * way: the token is single-use, so the password becomes whatever the typo made it and the link that
 * would let them try again is already spent. It never reaches the server — `ResetPasswordRequest`
 * has two fields — it exists so the mistake is caught while it is still a mistake.
 *
 * The refinement points at `confirmPassword` rather than at the object, so `@mantine/form` renders
 * it under the second field: an error attached to the form has no `aria-describedby` to belong to
 * (`rules/errors-and-toasts.mdc` §4, `rules/a11y.mdc` §18).
 */
export const resetPasswordFormSchema = z
  .object({
    newPassword: SharedValidation.passwordSchema,
    // No policy of its own: it is right when it equals the first field and wrong otherwise, and a
    // second «too short» under it would be one mistake reported twice.
    confirmPassword: z.string(),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    error: PASSWORD_MISMATCH_MESSAGE_KEY,
    path: ['confirmPassword'],
  });

export type ResetPasswordFormValues = z.infer<typeof resetPasswordFormSchema>;
