import { isoDateTimeSchema, projectIdSchema, userIdSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

import { PROJECT_KEY_PATTERN, normalizeProjectKey } from '@/domain/project/project-key.value.js';
import { PROJECT_ROLES, PROJECT_VISIBILITIES } from '@/domain/project/project.enums.js';

/**
 * The request schemas of the project surface.
 *
 * `projectId` is the shared branded uuid, and it is refused at the boundary for the reason every
 * other id parameter is: `scope()` casts it with `::uuid` inside the transaction, so a value that is
 * not one would raise in PostgreSQL and be answered `500` — an invitation to retry something that
 * can never succeed. `422` at the edge is the honest answer, and it says nothing about existence.
 *
 * **The key is normalized here and refused here** (STORY-014-01, acceptance 2): `" bad "` becomes
 * `BAD` through the value object's `normalizeProjectKey`, and what the value object would not call
 * a key is refused with the field named — the same pattern `ck_projects_key_format` holds, so the
 * database never sees a spelling the schema let through. **The update schema has no `key` at all**
 * (acceptance 4): `strictObject` answers a `key` in a `PATCH` body as `unrecognized_keys` on the
 * field, which is the story's «422 on `key`» without a code of its own.
 *
 * **Dates are validated against each other at the boundary** (acceptance 8): `dueAt < startedAt`
 * is a `custom` issue on `dueAt`, so a form marks the one field that is wrong.
 */

const NAME_MAX = 120;
const DESCRIPTION_MAX = 2000;

/**
 * A colour is a **name from the palette**, never a hex literal (`ProjectDetail.color` in the
 * contract): the client resolves it through its theme, and a value the theme does not know renders
 * as nothing rather than as an injected style. Held to the shape of a palette name here; which names
 * the palette has is the client's to decide.
 */
const COLOR_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

const projectKeySchema = z
  .string({ error: 'validation.projectKey.invalid' })
  .transform(normalizeProjectKey)
  .refine((key) => PROJECT_KEY_PATTERN.test(key), { error: 'validation.projectKey.invalid' });

const projectVisibilitySchema = z.enum(PROJECT_VISIBILITIES, {
  error: 'validation.projectVisibility.invalid',
});

const projectRoleSchema = z.enum(PROJECT_ROLES, { error: 'validation.projectRole.invalid' });

const allocationPctSchema = z
  .number({ error: 'validation.allocationPct.invalid' })
  .int({ error: 'validation.allocationPct.invalid' })
  .min(0, { error: 'validation.allocationPct.invalid' })
  .max(100, { error: 'validation.allocationPct.invalid' });

/** ISO 8601 in UTC on the wire, a `Date` for the use-case; `null` is «not set». */
const optionalInstantSchema = isoDateTimeSchema
  .transform((value) => new Date(value))
  .nullish()
  .transform((value) => value ?? null);

const editableShape = {
  name: z
    .string({ error: 'validation.projectName.invalid' })
    .trim()
    .min(1, { error: 'validation.projectName.invalid' })
    .max(NAME_MAX, { error: 'validation.projectName.too_long' }),
  description: z
    .string()
    .trim()
    .max(DESCRIPTION_MAX)
    .nullish()
    .transform((value) => (value === undefined || value === '' ? null : value)),
  leadId: userIdSchema,
  startedAt: optionalInstantSchema,
  dueAt: optionalInstantSchema,
  color: z
    .string({ error: 'validation.projectColor.invalid' })
    .regex(COLOR_PATTERN, { error: 'validation.projectColor.invalid' }),
};

const datesInOrder = (
  value: { readonly startedAt: Date | null; readonly dueAt: Date | null },
  context: z.RefinementCtx,
): void => {
  if (value.startedAt !== null && value.dueAt !== null && value.dueAt < value.startedAt) {
    context.addIssue({
      code: 'custom',
      path: ['dueAt'],
      message: 'validation.projectDates.inverted',
    });
  }
};

export const createProjectBodySchema = z
  .strictObject({
    key: projectKeySchema,
    ...editableShape,
    /** Absent means the ordinary internal project — the same default the column carries. */
    visibility: projectVisibilitySchema.default('PUBLIC_ORG'),
  })
  .superRefine(datesInOrder);

/** Replace, not merge — and no `key`: it is part of every task number (acceptance 4). */
export const updateProjectBodySchema = z.strictObject(editableShape).superRefine(datesInOrder);

export const changeProjectVisibilityBodySchema = z.strictObject({
  visibility: projectVisibilitySchema,
});

export const projectIdParamsSchema = z.strictObject({ projectId: projectIdSchema });

export const projectMemberParamsSchema = z.strictObject({
  projectId: projectIdSchema,
  userId: userIdSchema,
});

export const addProjectMemberBodySchema = z.strictObject({
  userId: userIdSchema,
  /** Absent means an ordinary member — the same default the column carries. */
  projectRole: projectRoleSchema.default('MEMBER'),
  /** Absent means full time on this project — the column's own default. */
  allocationPct: allocationPctSchema.default(100),
});

/**
 * A field that is absent is left as it is; a body with neither field asks for nothing and is refused
 * as such, on the object, so a client that sent `{}` learns it sent nothing.
 */
export const updateProjectMemberBodySchema = z
  .strictObject({
    projectRole: projectRoleSchema.optional(),
    allocationPct: allocationPctSchema.optional(),
  })
  .refine((value) => value.projectRole !== undefined || value.allocationPct !== undefined, {
    error: 'validation.projectMember.empty_patch',
  });

/** `?includeLeft=true` shows the people who left beside the live roster (acceptance 10). */
export const projectMembersQuerySchema = z.strictObject({
  includeLeft: z.stringbool().default(false),
});
