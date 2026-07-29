import { SharedValidation } from '@bad-crm/shared';
import { z } from 'zod';

/**
 * What the sign-in form asks for, and the only validation it is entitled to do.
 *
 * The email is the shared schema, so «what counts as an address» is one answer for the form, the
 * registration flow and the server (`packages/shared/src/validation/email.schema.ts`).
 *
 * The **password is checked for presence only**, and that is deliberate rather than lazy.
 * `SharedValidation.passwordSchema` carries the *policy* — twelve characters and up — and a policy
 * belongs to the screen that sets a password, not to the one that types an existing one. Enforcing
 * it here would refuse a legitimate password chosen before the policy changed, and would tell an
 * attacker the shape of every password on the installation before a single request is sent. The
 * authority on whether these credentials are right is `POST /auth/login`, which answers
 * `invalid_credentials` and nothing more (CLAUDE.md, invariant 2: the client check is a hint).
 *
 * Messages are i18n keys, never sentences (`rules/i18n.mdc` §1); `@mantine/form` renders them
 * under the field they belong to, which is where a validation error goes — never a toast
 * (`rules/errors-and-toasts.mdc` §4).
 */
export const loginFormSchema = z.object({
  email: SharedValidation.emailSchema,
  password: z.string().min(1, { error: 'validation.password.required' }),
});

export type LoginFormValues = z.infer<typeof loginFormSchema>;
