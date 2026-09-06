import { type SharedOrganization } from '@bad-crm/shared';

/** One unexpired role the subject holds, with the moment it was handed to them. */
export interface HeldRoleGrant {
  /** `Role.key` — a system role key, or the key of a custom role. */
  readonly roleKey: string;
  /** `Role.id` — how the policy names a custom role, which has no stable key across tenants. */
  readonly roleId: string;
  /** `UserRole.grantedAt`; the other half of the countdown (acceptance 5). */
  readonly grantedAt: Date;
}

/**
 * What the organization's policy has to say about one person, right now.
 *
 * - `not_covered` — the policy names none of their roles. Nothing is asked of them.
 * - `satisfied` — covered, and they have a second factor. Nothing is asked of them either, but the
 *   distinction is kept because the coverage report counts these separately and because losing the
 *   second factor moves them to one of the two below rather than to `not_covered`.
 * - `grace` — covered, no second factor, and the countdown has not run out. They work normally and
 *   the client shows the banner (acceptance 4); `graceEndsAt` is what it counts down to.
 * - `enrollment_required` — covered, no second factor, countdown over. The session issued to them
 *   carries the `mfa_enrollment` scope and reaches nothing but TOTP setup and sign-out
 *   (acceptance 3).
 */
export type MfaGate = 'not_covered' | 'satisfied' | 'grace' | 'enrollment_required';

export interface MfaRequirementVerdict {
  readonly gate: MfaGate;
  /** Whether the policy names a role this person holds, regardless of what they have enrolled. */
  readonly covered: boolean;
  /**
   * When the grace period ends, in epoch milliseconds; `undefined` when nobody is covered.
   *
   * A number rather than a `Date` because this file is `domain`: `new Date(...)` is banned there by
   * `test/unit/architecture/layers.test.ts`, and the ban is not pedantry — the same construction
   * that builds an instant from an argument builds one from the clock, and a regex cannot tell them
   * apart. The application layer turns it into a `Date` at the one line it needs one.
   */
  readonly graceEndsAtMs: number | undefined;
}

export interface MfaRequirementInput {
  readonly policy: SharedOrganization.SecurityPolicy;
  readonly roles: readonly HeldRoleGrant[];
  readonly hasSecondFactor: boolean;
  readonly now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When the requirement attached to this particular grant.
 *
 * The later of the two dates, and never one of them alone. The policy's own date answers «since
 * when does this role need a second factor»; the grant answers «since when does this person hold
 * that role». Taking only the first hands somebody promoted a year later a countdown that expired
 * before they were covered — acceptance 5 in as many words. Taking only the second hands everybody
 * who has held the role since the founding a countdown that started then, which is the same defect
 * pointing the other way.
 *
 * A role in the policy with no recorded date falls back to the grant. The use-case writes a date for
 * every role it stores, so this is reachable only from a column something outside this codebase
 * edited — and the grant is the strictest honest reading of it, rather than «covered by nothing».
 */
const attachedAt = (grant: HeldRoleGrant, policy: SharedOrganization.SecurityPolicy): number => {
  const recorded = policy.mfaRequiredSince[grant.roleId] ?? policy.mfaRequiredSince[grant.roleKey];
  const since = recorded === undefined ? Number.NaN : Date.parse(recorded);

  // `NaN` covers both «no date recorded» and «a date nothing can parse»: the fallback is the same,
  // and it is the grant — see the paragraph above for why that is the strict reading rather than
  // the lenient one.
  return Math.max(
    Number.isNaN(since) ? Number.NEGATIVE_INFINITY : since,
    grant.grantedAt.getTime(),
  );
};

/**
 * Whether this organization's policy requires a second factor of this person, and by when.
 *
 * Pure, and in `domain` rather than beside its callers, because three of them exist and they must
 * agree: the session issue that decides the token's scope, the refusal to turn 2FA off
 * (acceptance 6), and the coverage report the administration screen renders. Three copies of this
 * arithmetic would be three answers to «is Ivan required to enrol», and the first symptom would be
 * a screen that says «compliant» about somebody the login gate is locking out.
 *
 * **The earliest covering role wins.** Somebody who is both an `admin` (covered since the first of
 * the month) and a `manager` (covered since yesterday) has been under the requirement since the
 * first of the month: the requirement attached the first time any covering role did, and a later
 * one cannot restart a countdown that is already running.
 */
export const evaluateMfaRequirement = (input: MfaRequirementInput): MfaRequirementVerdict => {
  const named = new Set<string>(input.policy.mfaRequiredForRoles);
  const covering = input.roles.filter(
    (grant) => named.has(grant.roleId) || named.has(grant.roleKey),
  );

  if (covering.length === 0) {
    return { gate: 'not_covered', covered: false, graceEndsAtMs: undefined };
  }

  const requiredSince = Math.min(...covering.map((grant) => attachedAt(grant, input.policy)));
  const graceEndsAtMs = requiredSince + input.policy.mfaGracePeriodDays * DAY_MS;

  if (input.hasSecondFactor) return { gate: 'satisfied', covered: true, graceEndsAtMs };

  const gate = input.now.getTime() >= graceEndsAtMs ? 'enrollment_required' : 'grace';

  return { gate, covered: true, graceEndsAtMs };
};
