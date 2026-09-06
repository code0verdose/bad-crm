import { SharedOrganization } from '@bad-crm/shared';
import { z } from 'zod';

/**
 * The body of `PATCH /organization/security-policy`.
 *
 * It is **not** `securityPolicySchema` itself, and the difference is the point: `mfaRequiredSince`
 * is computed by the use-case from the policy that is already stored, so a client that could send it
 * could hand itself a grace period that expired last year. The object is strict, so sending the
 * field is a 422 rather than a value quietly ignored.
 */
export const updateSecurityPolicyBodySchema = z.strictObject({
  mfaRequiredForRoles: z
    .array(SharedOrganization.policyRoleRefSchema)
    .max(SharedOrganization.MFA_POLICY_ROLES_MAX),
  mfaGracePeriodDays: z
    .int({ error: 'validation.number.integer' })
    .min(0)
    .max(SharedOrganization.MFA_GRACE_PERIOD_DAYS_MAX),
  /**
   * `true` only on the repeat of a request refused with 428 `confirmation_required` because the
   * caller was putting themselves under a requirement they do not meet (acceptance 7).
   */
  confirmedSelfLockout: z.boolean().optional(),
});

/**
 * The query of `GET /organization/mfa-coverage`.
 *
 * The two draft parameters are optional and travel together: the report is about the stored policy
 * unless the screen is previewing an unsaved one. `mfaRequiredForRoles` is repeated
 * (`?role=owner&role=admin`) rather than comma-joined, because a role reference may be a uuid and a
 * separator inside a value is how a filter starts silently dropping entries.
 */
export const mfaCoverageQuerySchema = z
  .object({
    role: z
      .union([
        SharedOrganization.policyRoleRefSchema,
        z.array(SharedOrganization.policyRoleRefSchema),
      ])
      .optional(),
    graceDays: z.coerce
      .number()
      .int()
      .min(0)
      .max(SharedOrganization.MFA_GRACE_PERIOD_DAYS_MAX)
      .optional(),
  })
  .transform((query) => ({
    draft:
      query.role === undefined && query.graceDays === undefined
        ? undefined
        : {
            mfaRequiredForRoles: query.role === undefined ? [] : [query.role].flat(),
            mfaGracePeriodDays: query.graceDays ?? 0,
          },
  }));
