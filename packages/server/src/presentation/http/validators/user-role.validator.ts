import { roleIdSchema, userIdSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

/**
 * The request schemas of the assignment surface.
 *
 * `strictObject`, like every other body in this API: an endpoint that ignores an unknown field lets
 * a client ship `expires_at` against an operation that reads `expiresAt`, get a 200, and discover in
 * production that the grant never expires.
 */

export const userIdParamsSchema = z.strictObject({ userId: userIdSchema });

export const userRoleParamsSchema = z.strictObject({
  userId: userIdSchema,
  roleId: roleIdSchema,
});

export const assignRoleBodySchema = z.strictObject({
  roleId: roleIdSchema,
  /**
   * When the grant stops applying. `null` — or absent — means «until revoked».
   *
   * A past date is refused here rather than accepted and ignored: an assignment that expired before
   * it was made grants nothing, and the caller who wrote it believes somebody has access. The
   * comparison is against the moment of parsing, which is the only clock this layer legitimately
   * has — the use-case does not re-check it, because a grant that expires between the request and
   * the write is a grant that expired, not an invalid one.
   */
  expiresAt: z.iso
    .datetime({ error: 'validation.expiresAt.invalid' })
    .refine((value) => new Date(value).getTime() > Date.now(), {
      error: 'validation.expiresAt.past',
    })
    .nullish(),
});
