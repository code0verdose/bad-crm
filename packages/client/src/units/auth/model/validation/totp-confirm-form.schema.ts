import { z } from 'zod';

import { totpCodeSchema } from './totp-code.schema.js';

/**
 * What the last step of enrolment asks for: the code from the authenticator **and** the account's
 * current password.
 *
 * The password is required by the contract and it is not ceremony. Holding a session is not proof
 * of being the account's owner: an attacker with a stolen access token would otherwise attach
 * **their** authenticator, take the ten recovery codes, and leave the owner locked out — unable to
 * sign in once verification lands and unable to turn 2FA off, because disabling does not exist yet
 * (STORY-013-04). The server checks it whatever the code turns out to be, so a refusal says nothing
 * about the code.
 *
 * **The password is checked for presence only**, exactly as on the sign-in form and for the reason
 * written there at length (`login-form.schema.ts`): the policy — twelve characters and up — belongs
 * to the screen that *sets* a password, not to one that types an existing one, and enforcing it
 * here would refuse a legitimate password chosen before the policy changed. The authority is the
 * server, which answers `403 reauthentication_required` and nothing more.
 */
export const totpConfirmFormSchema = z.object({
  code: totpCodeSchema,
  currentPassword: z.string().min(1, { error: 'validation.password.required' }),
});

export type TotpConfirmFormValues = z.infer<typeof totpConfirmFormSchema>;
