import { passwordSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

/**
 * Request schemas of the 2FA surface, one per body the contract declares.
 *
 * `strictObject` throughout, matching `additionalProperties: false` in `docs/api/openapi.yaml`
 * (`auth.validator.ts` documents why at length). No schema here accepts a `userId`: the actor is
 * always read from the session the guard established, never from the body
 * (STORY-013-01, acceptance 9).
 */

/**
 * Six digits, exactly — the width every authenticator app renders (`TOTP_CODE_DIGITS`). `.regex`
 * rather than `z.coerce.number()`: a code with a leading zero is a legitimate TOTP output, and
 * coercing to a number would silently drop it before the comparison ever runs.
 */
const totpCodeSchema = z
  .string({ error: 'validation.totp_code.invalid' })
  .regex(/^\d{6}$/, { error: 'validation.totp_code.invalid' });

/**
 * `POST /auth/2fa/confirm`.
 *
 * `currentPassword` carries the same `passwordSchema` `regenerateRecoveryCodesBodySchema` uses below,
 * for the identical reason — and it is required for the identical reason `ConfirmTotpUseCase`'s
 * docstring gives at length: enabling 2FA is a privileged change, and a bearer token alone must not
 * be enough to make it.
 *
 * The contract agrees: `ConfirmTotpRequest` in `docs/api/openapi.yaml` declares both fields required.
 * It did not while this schema was being written, and the note recording that gap outlived the gap by
 * about an hour — which is the ordinary lifetime of a cross-cutting note and the reason they are
 * worth deleting the moment the other side lands.
 */
export const confirmTotpBodySchema = z.strictObject({
  code: totpCodeSchema,
  currentPassword: passwordSchema,
});

/**
 * `POST /auth/2fa/recovery-codes/regenerate`.
 *
 * `currentPassword` carries the same `passwordSchema` `changePasswordBodySchema` uses for the
 * identical reason: without a length policy on it, a caller could submit a megabyte string and have
 * it verified against an Argon2id digest before the field is even checked against anything.
 */
export const regenerateRecoveryCodesBodySchema = z.strictObject({
  currentPassword: passwordSchema,
  totpCode: totpCodeSchema,
});

export type ConfirmTotpBody = z.output<typeof confirmTotpBodySchema>;
export type RegenerateRecoveryCodesBody = z.output<typeof regenerateRecoveryCodesBodySchema>;
