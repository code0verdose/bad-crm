import { localeSchema, passwordSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

/**
 * The one request of the invitation surface that carries no session.
 *
 * **There is no `email` field, and its absence is the security property.** The account is created on
 * the address stored on the invitation; a body that could name one would let a holder of somebody
 * else's link create an account on an address of their choosing. `strictObject` is what makes the
 * absence enforceable rather than merely intended — a client sending `email` is refused 422 instead
 * of being quietly ignored, which is the difference between «we do not read it» and «you cannot
 * send it».
 *
 * Nothing about the person's name is here either. The table it was waiting for arrived with
 * STORY-012-03 — `employee_profiles`, with `first_name` and `last_name` `NOT NULL` — so the gap is
 * now a **decision** rather than a wait: accepting an invitation creates the account, and the
 * personnel record is created by the first edit of it, with empty names meaning «not filled in
 * yet». Taking a name here would mean writing a second table from an operation named after the
 * first, and doing it before anybody has agreed the name is right. The screen that asks for it is
 * `/admin/members/$userId`, where the person can also correct it.
 */

/** The same bounds the reset-password body uses: 32 CSPRNG bytes, whatever their encoding. */
const TOKEN_MIN = 32;
const TOKEN_MAX = 512;

export const acceptInvitationBodySchema = z.strictObject({
  token: z
    .string({ error: 'validation.token.invalid' })
    .min(TOKEN_MIN, { error: 'validation.token.invalid' })
    .max(TOKEN_MAX, { error: 'validation.token.invalid' }),
  /** The same policy registration and password reset apply — one schema, one set of rules. */
  password: passwordSchema,
  /** What the interface was in when they accepted; the account starts in that language. */
  locale: localeSchema,
  /**
   * IANA name, as the browser reports it. Optional, because a browser without full ICU has none to
   * report, and `UTC` is a correct answer rather than a placeholder.
   */
  timezone: z.string().min(1).max(64).optional(),
});
