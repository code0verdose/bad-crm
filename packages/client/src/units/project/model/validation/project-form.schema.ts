import { z } from 'zod';

import { PROJECT_VISIBILITIES } from '@units/project/model/enums/project-visibility.enums.js';

/**
 * A project as somebody fills it in — the create page and the settings section share these fields,
 * because `POST /projects` and `PATCH /projects/{projectId}` take the same shape minus two fields.
 *
 * Deliberately **not** the request body: the dates are calendar days (`YYYY-MM-DD`, what
 * `<input type="date">` holds) or `''` for «not set», and the description is `''` rather than
 * `null`. `toProjectDraft`/`toProjectPatch` translate, so the component never narrows a union.
 *
 * The bounds are the contract's (`ProjectDraft` in `docs/api/openapi.yaml`), so a value this accepts
 * and the endpoint refuses cannot be typed in: a form that submits and then shows an error nobody
 * can act on is what this pairing prevents. What the server still decides alone is whether the key
 * is free (`409 project_already_exists`) and whether the lead is a live account — both arrive as
 * errors of the field they are about (`project-form-failure.util.ts`).
 */

/** `ProjectDraft.name.maxLength`. */
export const MAX_PROJECT_NAME = 120;
/** `ProjectDraft.description.maxLength`. */
export const MAX_PROJECT_DESCRIPTION = 2000;
/** The key is 2–10 characters: one letter, then letters and digits (`^[A-Z][A-Z0-9]{1,9}$`). */
export const MAX_PROJECT_KEY = 10;

/**
 * The server's pattern, checked **after** the same normalization the server applies (trim and
 * upper-case): `" bad "` is a valid key, because it is stored as `BAD`.
 */
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
/** `ProjectDraft.color.pattern` — a palette name, never a hex literal. */
const PALETTE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** `YYYY-MM-DD`, or empty for «not set». */
const CALENDAR_DAY_OR_EMPTY = /^(\d{4}-\d{2}-\d{2})?$/;

const DUE_BEFORE_START_KEY = 'projects.field.dueBeforeStart';

const projectFields = z.object({
  key: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, { error: 'validation.required' })
    .regex(PROJECT_KEY_PATTERN, { error: 'projects.field.keyInvalid' }),
  name: z
    .string()
    .trim()
    .min(1, { error: 'validation.required' })
    .max(MAX_PROJECT_NAME, { error: 'validation.text.tooLong' }),
  description: z.string().trim().max(MAX_PROJECT_DESCRIPTION, { error: 'validation.text.tooLong' }),
  visibility: z.enum(PROJECT_VISIBILITIES, { error: 'validation.choice.invalid' }),
  /** Required and chosen from the directory — an empty choice is «nobody leads it», which is refused. */
  leadId: z.string().min(1, { error: 'projects.field.leadRequired' }),
  color: z.string().regex(PALETTE_NAME, { error: 'validation.choice.invalid' }),
  startedAt: z.string().regex(CALENDAR_DAY_OR_EMPTY, { error: 'projects.field.dateInvalid' }),
  dueAt: z.string().regex(CALENDAR_DAY_OR_EMPTY, { error: 'projects.field.dateInvalid' }),
});

/**
 * The deadline is not before the start — attached to `dueAt`, the field the person has to move,
 * which is also where the server's `422` points (`rules/zod-validation.mdc` §7). Compared as
 * calendar days, which for `YYYY-MM-DD` is the string order.
 */
const dueNotBeforeStart = (
  values: { readonly startedAt: string; readonly dueAt: string },
  context: z.RefinementCtx,
): void => {
  if (values.startedAt !== '' && values.dueAt !== '' && values.dueAt < values.startedAt) {
    context.addIssue({ code: 'custom', message: DUE_BEFORE_START_KEY, path: ['dueAt'] });
  }
};

/** The create page: every field, the key and the visibility included. */
export const projectFormSchema = projectFields.superRefine(dueNotBeforeStart);

export type ProjectFormValues = z.input<typeof projectFormSchema>;

/**
 * The settings section: no `key` — it is the prefix of every task number and never changes — and
 * no `visibility`, which is a decision of its own with a confirmation of its own.
 */
export const projectEditFormSchema = projectFields
  .omit({ key: true, visibility: true })
  .superRefine(dueNotBeforeStart);

export type ProjectEditFormValues = z.input<typeof projectEditFormSchema>;
