import { z } from 'zod';

/**
 * What the second step of the sign-in asks for: one code, in a field that takes either shape.
 *
 * **Deliberately not `totpCodeSchema`.** `POST /auth/2fa/verify` accepts six digits from an
 * authenticator **or** an unused recovery code in the same `code` field and decides for itself
 * which check to run (`VerifySecondFactorRequest` in `docs/api/openapi.yaml`; STORY-013-03
 * acceptance 7). Narrowing this to `\d{6}` would refuse a recovery code before the request left the
 * browser — on the one screen that exists for the person whose authenticator is gone, which is the
 * exact case recovery codes are for. The same reasoning, in the same words, stands over
 * `disable-totp-form.schema.ts`, which faces the same choice on the other side of the account.
 *
 * So the only thing this can honestly assert is presence. The upper bound the contract sets is
 * enforced at the keystroke by the field itself, for the reason `totp-code-field.component.tsx`
 * gives about its own: stopping the character is kinder than refusing the form afterwards.
 *
 * There is no `mfaToken` field. The token is not the person's to type and never travels through a
 * form value — it is held in memory by `lib/mfa-token-storage.util.ts` and attached by the mutation
 * (STORY-013-03, task «`mfaToken` не попадает ни в URL, ни в `localStorage`/`sessionStorage`»).
 *
 * The message is an i18n key, never a sentence (`rules/i18n.mdc` §1); `@mantine/form` renders it
 * under the field it belongs to (`rules/errors-and-toasts.mdc` §4).
 */
export const twoFactorFormSchema = z.object({
  code: z.string().min(1, { error: 'validation.second_factor.required' }),
});

export type TwoFactorFormValues = z.infer<typeof twoFactorFormSchema>;
