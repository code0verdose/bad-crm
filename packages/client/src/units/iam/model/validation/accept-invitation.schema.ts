import { localeSchema, passwordSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

/** i18next key of «the two passwords differ» — a key, never a sentence (`rules/i18n.mdc` §1). */
const PASSWORD_MISMATCH_MESSAGE_KEY = 'validation.password.mismatch';

/**
 * The invitation form, as the invited person fills it in.
 *
 * **No address field, and that is the whole point of the screen.** The account is created on the
 * address stored on the invitation; a form that asked for one would be asking a question whose
 * answer is ignored — and a request that carried one is refused 422 by the server's strict schema.
 *
 * `confirmPassword` exists here and nowhere else: it is a property of the form, not of the request.
 * The contract has one password field, and a confirmation sent to the server would be a second copy
 * of a credential on the wire for no gain — the same split `resetPasswordFormSchema` makes.
 */
export const acceptInvitationFormSchema = z
  .object({
    password: passwordSchema,
    // No policy of its own: it is right when it equals the first field and wrong otherwise, and a
    // second «too short» under it would be one mistake reported twice.
    confirmPassword: z.string(),
    locale: localeSchema,
  })
  .refine((values) => values.password === values.confirmPassword, {
    error: PASSWORD_MISMATCH_MESSAGE_KEY,
    path: ['confirmPassword'],
  });

export type AcceptInvitationFormValues = z.infer<typeof acceptInvitationFormSchema>;
