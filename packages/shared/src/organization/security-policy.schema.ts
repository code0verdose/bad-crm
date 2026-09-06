import { z } from 'zod';

import { SYSTEM_ROLE_KEYS } from '../permissions/system-roles.enums.js';

/**
 * The longest grace period an organization may give itself, in days.
 *
 * Thirty rather than «any number»: a grace period is the window in which the policy is declared and
 * not yet enforced, and a window measured in months is a policy an auditor is told about and nobody
 * ever lives under. The bound is in the schema rather than in the screen so that a request made
 * with `curl` is held to it too.
 */
export const MFA_GRACE_PERIOD_DAYS_MAX = 30;

/**
 * How many roles one policy may name.
 *
 * The ceiling exists because this array is read on every session issue and because an unbounded
 * array in a JSON column is an unbounded write. Seven system roles plus a generous allowance for
 * custom ones; an organization that needs more than this is describing «everybody», and the way to
 * say that is to name the roles everybody actually holds.
 */
export const MFA_POLICY_ROLES_MAX = 64;

/**
 * One role the policy names — a system role key, or the id of a custom role.
 *
 * Both spellings in one field rather than two fields, because the question the policy asks is «does
 * this person hold a role the policy names» and a person holds the two kinds identically. The union
 * is closed on the system side (`SYSTEM_ROLE_KEYS`) and shaped on the custom side (a uuid), so a
 * typo like `admins` is refused at the boundary instead of quietly covering nobody — which is the
 * failure mode that matters here: a security policy that silently applies to no one still reads as
 * «enabled» on the screen.
 */
export const policyRoleRefSchema = z.union([
  z.enum(SYSTEM_ROLE_KEYS),
  z.uuid({ error: 'validation.id.invalid' }),
]);

export type PolicyRoleRef = z.infer<typeof policyRoleRefSchema>;

/**
 * When each named role started being covered, keyed by the same reference the array carries.
 *
 * This is the field that makes STORY-013-05 acceptance 5 expressible at all: the countdown belongs
 * to the *pairing of a person and a role*, not to the policy, so the policy has to record when each
 * role entered it and the person's own `granted_at` supplies the other half. A single
 * `enabledAt` on the policy would give a colleague promoted a year later the countdown of the day
 * the policy was written, which is «no grace period» wearing one.
 */
const requiredSinceSchema = z.record(
  z.string(),
  z.iso.datetime({ error: 'validation.date.invalid' }),
);

/**
 * The organization's second-factor policy, as it is stored inside `Organization.settings`.
 *
 * Validated in **both** directions (acceptance 1): a write is parsed before it is stored, and a read
 * is parsed before it is believed. The second half is the one that earns its keep — `settings` is a
 * `Json` column, so anything that ever writes to it by hand, and every older shape from before a
 * field was added, arrives here as `unknown`.
 */
export const securityPolicySchema = z
  .object({
    mfaRequiredForRoles: z.array(policyRoleRefSchema).max(MFA_POLICY_ROLES_MAX).default([]),
    mfaGracePeriodDays: z
      .int({ error: 'validation.number.integer' })
      .min(0)
      .max(MFA_GRACE_PERIOD_DAYS_MAX)
      .default(0),
    mfaRequiredSince: requiredSinceSchema.default({}),
  })
  // Two entries for one role would give that role two start dates and make «since when» depend on
  // which one a reader happened to fold first.
  .refine(
    (policy) => new Set(policy.mfaRequiredForRoles).size === policy.mfaRequiredForRoles.length,
    {
      error: 'validation.array.duplicate',
      path: ['mfaRequiredForRoles'],
    },
  );

export type SecurityPolicy = z.infer<typeof securityPolicySchema>;

/**
 * Everything an organization keeps in `settings`, with the keys other epics will add left in place.
 *
 * Loose on purpose: this schema is used to *rewrite* the column, and a strict object would delete
 * every setting a future epic put beside this one the first time somebody changed the grace period.
 */
export const organizationSettingsSchema = z.looseObject({
  securityPolicy: securityPolicySchema.optional(),
});

/** What a fresh installation has, and what an unreadable column is read as (acceptance 10). */
export const DISABLED_SECURITY_POLICY: SecurityPolicy = {
  mfaRequiredForRoles: [],
  mfaGracePeriodDays: 0,
  mfaRequiredSince: {},
};

/**
 * The policy stored in `settings`, or the disabled one.
 *
 * **It never throws, and that is a decision about failure rather than about convenience.** This runs
 * on the path that issues a session. A column a future migration, a hand-edit or a partial write
 * left malformed would otherwise make every sign-in of that organization answer 500 — locking
 * everybody out over a policy that is supposed to be *off* by default. Failing to the disabled
 * policy is the direction that keeps people working; the direction that keeps them out is available
 * to an administrator by writing the policy again.
 *
 * The trade is stated so nobody has to guess at it: a corrupted column silently stops enforcing the
 * second factor. The caller is expected to log the parse failure — `UpdateSecurityPolicyUseCase`
 * writes only shapes this schema accepted, so a failure here means something outside this codebase
 * wrote the column.
 */
export const readSecurityPolicy = (settings: unknown): SecurityPolicy => {
  const parsed = organizationSettingsSchema.safeParse(settings);

  if (!parsed.success) return DISABLED_SECURITY_POLICY;

  return parsed.data.securityPolicy ?? DISABLED_SECURITY_POLICY;
};

/** Whether the policy asks anything of anybody. An empty role list is «off», not «everybody». */
export const isPolicyEnabled = (policy: SecurityPolicy): boolean =>
  policy.mfaRequiredForRoles.length > 0;

/**
 * The `settings` object to store: the one that was there, with the policy replaced.
 *
 * Unreadable stored settings are replaced rather than merged — there is nothing to merge with, and
 * refusing the write would leave the organization unable to set a policy at all because of a column
 * only this operation can repair.
 */
export const writeSecurityPolicy = (
  settings: unknown,
  policy: SecurityPolicy,
): Record<string, unknown> => {
  const parsed = organizationSettingsSchema.safeParse(settings);

  return { ...(parsed.success ? parsed.data : {}), securityPolicy: policy };
};
