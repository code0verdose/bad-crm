import { SharedValidation } from '@bad-crm/shared';
import { z } from 'zod';

/**
 * What the recovery form asks for, and the only thing it is entitled to decide.
 *
 * The address is the shared schema, so «what counts as an address» is one answer for this form, the
 * sign-in form and the server (`packages/shared/src/validation/email.schema.ts`).
 *
 * That is deliberately all. `POST /auth/forgot-password` answers 202 whether or not the address is
 * registered — a different status for an unknown one would make the operation the enumeration
 * oracle it is built not to be — so there is nothing here for the client to anticipate and nothing
 * it may infer. The check is about the shape of what was typed, so a typo costs a round trip
 * instead of a mail that never arrives (CLAUDE.md, invariant 2: the client check is a hint).
 */
export const forgotPasswordFormSchema = z.object({
  email: SharedValidation.emailSchema,
});

export type ForgotPasswordFormValues = z.infer<typeof forgotPasswordFormSchema>;
