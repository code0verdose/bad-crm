import { SharedValidation } from '@bad-crm/shared';
import { z } from 'zod';

import { PASSWORD_MISMATCH_MESSAGE_KEY } from './reset-password-form.schema.js';

/**
 * `docs/api/openapi.yaml` → `OrganizationSlug.pattern`, restated for the same reason
 * `units/team/model/validation/team-form.schema.ts` restates it: `SharedValidation.slugSchema`
 * lower-cases before it matches, so it *accepts* `Bad-Company` where the contract refuses it, and
 * it answers with `validation.slug.*` rather than with a key this form renders under an input.
 *
 * A second statement of a rule is only safe while something notices the two disagreeing:
 * `test/api/register-form-bounds.test.ts` reads the pattern and the bounds off the specification
 * and holds this schema to them in both directions.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `RegisterOrganizationRequest.organization.name.maxLength`; the component caps its input by it. */
export const MAX_ORGANIZATION_NAME = 120;

/** Not a third copy: the number the server's own `slugSchema` enforces, imported rather than typed. */
export const MAX_ORGANIZATION_SLUG = SharedValidation.SLUG_MAX_LENGTH;

/**
 * What the registration screen asks for: an organization, and the account that will own it.
 *
 * It is deliberately **not** the request body. `RegisterOrganizationRequest` nests the two halves
 * and carries a locale and a time zone that no field asks for — the interface already knows both —
 * so the translation lives in `use-registration.hook.ts` and the component never holds a shape it
 * has to build before it can render.
 *
 * **The password policy is enforced here**, unlike on the sign-in form, and the difference is the
 * one `reset-password-form.schema.ts` states: this screen *sets* a password. It is
 * `SharedValidation.newPasswordSchema` — the bounds the server's validator applies plus the shape
 * check its use-case applies, both from `packages/shared/src/validation` — rather than a second
 * statement of either that could drift. Until 2026-09-06 the form carried the bounds alone, and a
 * password the server called weak came back as a `422` the form could not place.
 *
 * **The confirmation field never reaches the server**, and it is not ceremony either. This is the
 * first password of an installation: nobody can reset it for the person who typed it, the address
 * it would be mailed to is the one they are inventing on the same screen, and recovery needs an
 * `SMTP_URL` a fresh installation may not have yet. A typo here is the whole account.
 *
 * Messages are i18n keys, never sentences (`rules/i18n.mdc` §1).
 */
export const registerFormSchema = z
  .object({
    organizationName: z
      .string()
      .trim()
      .min(1, { error: 'validation.required' })
      .max(MAX_ORGANIZATION_NAME, { error: 'auth.register.field.nameTooLong' }),
    /**
     * The pattern is checked here rather than left to a 422, and not to save a round trip: a
     * rejected body is one sentence about the whole request, while this is the field the person has
     * to fix — and the slug is the field most likely to be wrong, because it is the only one whose
     * rules are not obvious from the label.
     */
    slug: z
      .string()
      .trim()
      .min(1, { error: 'validation.required' })
      .max(MAX_ORGANIZATION_SLUG, { error: 'auth.register.field.slugTooLong' })
      .regex(SLUG_PATTERN, { error: 'auth.register.field.slugInvalid' }),
    email: SharedValidation.emailSchema,
    password: SharedValidation.newPasswordSchema,
    // No policy of its own: it is right when it equals the password and wrong otherwise, and a
    // second «too short» under it would be one mistake reported twice.
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    error: PASSWORD_MISMATCH_MESSAGE_KEY,
    path: ['confirmPassword'],
  });

export type RegisterFormValues = z.infer<typeof registerFormSchema>;
