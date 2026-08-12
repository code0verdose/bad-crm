import { z } from 'zod';

/**
 * Six digits, the width every authenticator app renders — and the shape both forms of the second
 * factor ask for (`docs/api/openapi.yaml` → `TotpCode`).
 *
 * Declared once and composed rather than repeated (`rules/zod-validation.mdc` §5): confirming an
 * enrolment and reissuing the recovery codes ask for the same value, and two copies of a regular
 * expression are two chances to disagree about what a code is.
 *
 * **A string, never `z.coerce.number()`.** `012345` is a legitimate code, and coercing to a number
 * drops the leading zero before the comparison the server makes ever runs — the server's own
 * validator carries the same note for the same reason.
 *
 * The message is an i18n key (`rules/i18n.mdc` §1); `@mantine/form` renders it under the field.
 */
export const totpCodeSchema = z
  .string()
  .regex(/^\d{6}$/, { error: 'validation.totp_code.invalid' });
