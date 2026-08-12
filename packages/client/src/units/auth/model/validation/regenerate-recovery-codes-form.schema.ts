import { z } from 'zod';

import { totpCodeSchema } from './totp-code.schema.js';

/**
 * What replacing the recovery-code set asks for: the current password **and** a live code from the
 * authenticator.
 *
 * Both, always. The set being replaced is the only way back into an account whose authenticator is
 * gone, so the operation that destroys ten of them is authorised by re-proving both factors rather
 * than by holding a session. The server refuses a wrong password, a wrong code and «this account
 * has no TOTP at all» with the same `403 reauthentication_required`, and it evaluates both proofs
 * whatever the first one says — which is why this form cannot usefully tell them apart either.
 *
 * The password is checked for presence only, for the reason `totp-confirm-form.schema.ts` gives.
 */
export const regenerateRecoveryCodesFormSchema = z.object({
  currentPassword: z.string().min(1, { error: 'validation.password.required' }),
  totpCode: totpCodeSchema,
});

export type RegenerateRecoveryCodesFormValues = z.infer<typeof regenerateRecoveryCodesFormSchema>;
