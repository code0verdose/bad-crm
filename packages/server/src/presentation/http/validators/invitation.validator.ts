import {
  emailSchema,
  invitationIdSchema,
  localeSchema,
  roleIdSchema,
  teamIdSchema,
} from '@bad-crm/shared/validation';
import { z } from 'zod';

/**
 * The request schemas of the invitation surface.
 *
 * `strictObject`, like every other body in this API: an endpoint that ignores an unknown field lets
 * a client ship `role_id` against an operation that reads `roleId`, get a 201, and discover later
 * that everybody it invited joined with no role at all.
 */

export const invitationIdParamsSchema = z.strictObject({ invitationId: invitationIdSchema });

/** How many teams one invitation may name. Beyond this it is an import, not an invitation. */
const MAX_TEAMS = 20;

export const createInvitationBodySchema = z.strictObject({
  /** Trimmed and lower-cased by `emailSchema`, which is what the `citext` column expects. */
  email: emailSchema,
  /**
   * The role the account will hold. `null` — or absent — is «somebody who can sign in and nothing
   * else», which is a legitimate invitation: an employee whose access is decided after a
   * conversation.
   */
  roleId: roleIdSchema.nullish(),
  /**
   * Teams to join on acceptance. Deduplicated here rather than in the database: the column is a
   * `uuid[]` draft with no constraint of its own, and the same team twice would become two rows in
   * `team_members` the day the invitation is accepted.
   */
  teamIds: z
    .array(teamIdSchema)
    .max(MAX_TEAMS, { error: 'validation.teamIds.tooMany' })
    .transform((ids) => [...new Set(ids)])
    .optional(),
  /**
   * Which language the letter is written in.
   *
   * Required, and deliberately not defaulted to English: the client knows which language its user
   * is reading, and a default here would silently send English to a Russian-speaking team whenever
   * a caller forgot the field — a defect nobody sees, because the person who reads the letter is
   * not the person who sent it.
   */
  locale: localeSchema,
});
