import { z } from 'zod';

/**
 * What turning the second factor **off** asks for: the current password and one second-factor
 * proof, in a single field that takes either shape.
 *
 * **The field names are the request's**, not this form's — `password` and `code`, exactly as
 * `DisableTotpRequest` publishes them. Its neighbour `regenerateRecoveryCodesFormSchema` maps
 * `currentPassword`/`totpCode` because that operation named them so; here the values submitted by
 * `@mantine/form` are the body, and a rename between the two would be a place for one of them to go
 * missing silently.
 *
 * **One field for the code, and it is deliberately not `totpCodeSchema`.** The server decides from
 * the shape of what was typed whether to check a live TOTP code or an unused recovery code
 * (`docs/api/openapi.yaml`, `disableTotp`), and the whole point of accepting both is the person
 * whose authenticator is gone and who has only the printed sheet. A six-digit rule here would refuse
 * that person's only credential before the request left the browser — on the one screen that exists
 * for them.
 *
 * So the only thing this can honestly assert is presence. The upper bound the contract sets
 * (`maxLength: 32`) is enforced at the keystroke by the field itself, for the reason
 * `totp-code-field.component.tsx` gives about its own: stopping the character is kinder than
 * refusing the form afterwards.
 *
 * The password is checked for presence only, for the reason `totp-confirm-form.schema.ts` gives —
 * the policy that decides whether a password is good belongs to the operation that sets one, and a
 * length rule here would refuse to *send* a password that predates the current policy.
 */
export const disableTotpFormSchema = z.object({
  password: z.string().min(1, { error: 'validation.password.required' }),
  code: z.string().min(1, { error: 'validation.second_factor.required' }),
});

export type DisableTotpFormValues = z.infer<typeof disableTotpFormSchema>;
