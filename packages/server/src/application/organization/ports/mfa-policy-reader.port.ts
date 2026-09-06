import { type HeldRoleGrant } from '@/domain/identity/access/mfa-requirement.policy.js';

/** One person, as the coverage report of acceptance 2 and 9 counts them. */
export interface MfaCoverageSubject {
  readonly userId: string;
  readonly email: string;
  /** Unexpired grants only — a lapsed role covers nobody, so it must not colour the report either. */
  readonly roles: readonly HeldRoleGrant[];
  /** `null` when this account has no confirmed second factor. */
  readonly totpEnabledAt: Date | null;
}

/**
 * The two reads the second-factor policy needs and no existing port already answers.
 *
 * Separate from `EffectivePermissionsReaderPort`, which is the other reader of `user_roles`, because
 * that one deliberately answers «what may this person do» and refuses to expose anything a policy
 * could decide by instead. This one answers a different question — *when* a role was handed over —
 * and mixing the two would put a date into the capability read that runs on every request.
 *
 * Both methods resolve inside the tenant scope the caller opened; neither takes an `organizationId`
 * (`rules/tenancy-rls.mdc`, 9).
 */
export interface MfaPolicyReaderPort {
  /**
   * Every unexpired role the subject holds, with its `granted_at`.
   *
   * Empty for a person with no roles and for a person who is not in this organization — the caller
   * of this port has already established who the caller is, and «no covering role» is the correct
   * answer to both.
   */
  roleGrantsOf(userId: string): Promise<readonly HeldRoleGrant[]>;

  /**
   * Every active account of the organization with its roles and its enrolment state.
   *
   * The whole tenant rather than «the people the policy covers»: the screen filters by role and by
   * status itself (acceptance 9), and — more to the point — the *preview* of a draft policy
   * (acceptance 2) asks about roles that are not in the stored policy yet, so a query filtered by
   * the stored one could not answer it.
   */
  coverageSubjects(): Promise<readonly MfaCoverageSubject[]>;
}
