import { SharedValidation } from '@bad-crm/shared';
import { z } from 'zod';

/**
 * A team as somebody fills it in — the create dialog and the rename section share this shape,
 * because the endpoints do: `POST /teams` and `PATCH /teams/{teamId}` both take a whole `TeamDraft`.
 *
 * It is deliberately **not** the request body. `description` is `''` here — an empty text input has
 * an empty value, not an absent key — while the contract's field is nullable prose, and «cleared»
 * has to be expressible. The translation is `toTeamDraft`, so the component never holds a union it
 * has to narrow before every render.
 *
 * The bounds are the contract's, so a value this accepts and the endpoint refuses cannot exist: a
 * form that submits and then shows an error nobody can act on is the failure this pairing prevents.
 */

/**
 * `docs/api/openapi.yaml` → `TeamDraft.slug.pattern`, restated because nothing publishes it.
 *
 * The bound beside it *is* imported — `SharedValidation.SLUG_MAX_LENGTH` below — but the pattern in
 * `packages/shared/src/validation/slug.schema.ts` is module-local, and `slugSchema`, the only shape
 * shared exports it in, cannot stand in for it here: it lower-cases before it matches, so it accepts
 * `Backend` where the contract's `^[a-z0-9]…` does not, and it answers with `validation.slug.*`
 * instead of the field-level keys this form renders under its inputs. So this one copy stays, and is
 * held to the contract instead of trusted: `test/api/team-form-bounds.test.ts` compares what this
 * schema accepts against `TeamDraft.slug.pattern` read off the specification, in both directions.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Exported rather than kept local: `team-form.component.tsx` needs the same three numbers for its
 * `maxLength` props, and a component that retyped them would be a second copy of the contract's
 * bound — the two only ever agreeing by coincidence. One constant, two readers, is what
 * `src/units/team/ui/team-form.component.test.tsx:39,48,57` («caps the … at the schema bound»)
 * exists to keep true.
 *
 * `MAX_SLUG` is not a number this file picks: it is the constant the server's own `slugSchema`
 * enforces, imported rather than retyped. `MAX_NAME` and `MAX_DESCRIPTION` have no such counterpart
 * — the server keeps private `NAME_MAX`/`DESCRIPTION_MAX`
 * (`packages/server/src/presentation/http/validators/team.validator.ts:16-17`) and shared publishes
 * neither — so for those two the specification is the only common source, and
 * `test/api/team-form-bounds.test.ts` is what makes it one rather than a shared assumption.
 */
export const MAX_NAME = 120;
export const MAX_SLUG = SharedValidation.SLUG_MAX_LENGTH;
export const MAX_DESCRIPTION = 500;

export const teamFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: 'validation.required' })
    .max(MAX_NAME, { error: 'teams.field.nameTooLong' }),
  /**
   * The pattern is checked here rather than left to a 422, and not to save a round trip: a rejected
   * body is one sentence about the whole request, while this is the field the person has to fix.
   */
  slug: z
    .string()
    .trim()
    .min(1, { error: 'validation.required' })
    .max(MAX_SLUG, { error: 'teams.field.slugTooLong' })
    .regex(SLUG_PATTERN, { error: 'teams.field.slugInvalid' }),
  description: z.string().trim().max(MAX_DESCRIPTION, { error: 'teams.field.descriptionTooLong' }),
});

export type TeamForm = z.infer<typeof teamFormSchema>;
