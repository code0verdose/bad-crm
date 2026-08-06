import { PERMISSIONS } from '@bad-crm/shared/permissions';
import { userIdSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

/** The catalogue as a Zod enum: a key nobody declared cannot reach a policy. */
const permissionKeySchema = z.enum(PERMISSIONS as unknown as [string, ...string[]], {
  error: 'validation.permissionKey.unknown',
});

/** Ten characters after trimming — the same bound the database checks. */
const REASON_MIN = 10;
const REASON_MAX = 500;

/**
 * The pair that identifies one exception.
 *
 * The parameter is `permission`, not `permissionKey`: the contract test refuses any path parameter
 * whose name suggests a credential, and «key» is one of the words it matches. Renaming costs a
 * syllable; an allow-list would cost the rule.
 */
export const overrideParamsSchema = z.strictObject({
  userId: userIdSchema,
  permission: permissionKeySchema,
});

export const userOverridesParamsSchema = z.strictObject({ userId: userIdSchema });

export const writeOverrideBodySchema = z.strictObject({
  effect: z.enum(['ALLOW', 'DENY'], { error: 'validation.effect.invalid' }),
  /**
   * Why this exception exists.
   *
   * Checked here **and** by a `CHECK` constraint, which is not redundancy for its own sake: the
   * length is a product rule («a reason nobody can read is not a reason»), and the constraint is
   * what makes it true for rows written by a script or a migration. Six months later this field is
   * the only thing that explains why one person differs from their role.
   */
  reason: z
    .string({ error: 'validation.reason.invalid' })
    .trim()
    .min(REASON_MIN, { error: 'validation.reason.too_short' })
    .max(REASON_MAX, { error: 'validation.reason.too_long' }),
  /**
   * When it stops applying. `null` — or absent — means «until removed», which the interface asks the
   * administrator to choose deliberately for an ALLOW.
   */
  expiresAt: z.iso
    .datetime({ error: 'validation.expiresAt.invalid' })
    .refine((value) => new Date(value).getTime() > Date.now(), {
      error: 'validation.expiresAt.past',
    })
    .nullish(),
});
