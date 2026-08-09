import { slugSchema, teamIdSchema, userIdSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

/**
 * The request schemas of the team surface.
 *
 * `slug` reuses the shared schema rather than restating a pattern: a team is addressed by slug in
 * the same URLs an organization and a project are, and two spellings of «URL-safe identifier» in one
 * product is how `/teams/back-end` and `/teams/back_end` end up both existing.
 *
 * There is no `leadId`. The lead is a membership with `teamRole = 'LEAD'`, which is what the schema
 * actually stores (`ck_team_members_role`); accepting one here would create a second model of the
 * same fact — see the story file, «Расхождение с этой спекой».
 */

const NAME_MAX = 120;
const DESCRIPTION_MAX = 500;

/**
 * `MEMBER` | `LEAD`, exactly as `ck_team_members_role` constrains the column.
 *
 * Refused at the boundary rather than left to the CHECK: a value the database rejects arrives as
 * `23514` and is answered `500`, which tells a client to retry something that can never succeed.
 */
const teamRoleSchema = z.enum(['MEMBER', 'LEAD'], { error: 'validation.teamRole.invalid' });

const teamShape = {
  name: z
    .string({ error: 'validation.teamName.invalid' })
    .trim()
    .min(1, { error: 'validation.teamName.invalid' })
    .max(NAME_MAX, { error: 'validation.teamName.too_long' }),
  slug: slugSchema,
  description: z.string().trim().max(DESCRIPTION_MAX).nullish(),
};

export const createTeamBodySchema = z.strictObject(teamShape);

/**
 * The same shape for an edit: **replace, not merge**.
 *
 * A partial body would make «clear the description» unexpressible without a sentinel, and the field
 * is optional prose rather than something a client can be relied on to round-trip.
 */
export const updateTeamBodySchema = z.strictObject(teamShape);

export const teamIdParamsSchema = z.strictObject({ teamId: teamIdSchema });

export const teamMemberParamsSchema = z.strictObject({
  teamId: teamIdSchema,
  userId: userIdSchema,
});

export const addTeamMemberBodySchema = z.strictObject({
  userId: userIdSchema,
  /** Absent means an ordinary member — the same default the column carries. */
  teamRole: teamRoleSchema.default('MEMBER'),
});
