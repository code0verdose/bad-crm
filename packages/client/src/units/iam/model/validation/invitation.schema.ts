import { emailSchema, localeSchema, roleIdSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

/**
 * The invite form, as the person fills it in.
 *
 * The same primitives the server parses the request with (`@bad-crm/shared/validation`), so the two
 * cannot drift apart: a field this accepts and the endpoint refuses is a form that submits and then
 * shows an error nobody can act on.
 *
 * It is deliberately **not** the request body. `roleId` is `''` here — a `Select` with nothing
 * chosen has an empty value, not an absent key — and the hook turns that into the `null` the API
 * documents. A schema that accepted `null` would leave the component holding a union it has to
 * narrow before every render.
 */
export const invitationFormSchema = z.object({
  email: emailSchema,
  /** `''` is «no role for now», which is a legitimate invitation rather than an unfinished form. */
  roleId: z.union([roleIdSchema, z.literal('')]),
  locale: localeSchema,
});

export type InvitationForm = z.infer<typeof invitationFormSchema>;
