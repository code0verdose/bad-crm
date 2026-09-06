import { SharedOrganization, SharedPermissions } from '@bad-crm/shared';

import { type CustomRoleRepositoryPort } from '@/application/iam/ports/role-repository.port.js';
import { type MfaPolicyReaderPort } from '@/application/organization/ports/mfa-policy-reader.port.js';
import { type TotpEnrollmentRepositoryPort } from '@/application/identity/ports/totp-enrollment.port.js';
import { type OrganizationRepositoryPort } from '@/application/organization/ports/organization-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { evaluateMfaRequirement } from '@/domain/identity/access/mfa-requirement.policy.js';
import { ConfirmationRequiredError } from '@/domain/shared/errors/app.errors.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

export interface UpdateSecurityPolicyInput {
  readonly actor: Actor;
  readonly mfaRequiredForRoles: readonly string[];
  readonly mfaGracePeriodDays: number;
  /**
   * The second signal of acceptance 7, sent only on the repeat of a request this use-case refused
   * with 428.
   *
   * A field of the request rather than a header or a query flag, for the same reason
   * `WriteRoleChangesUseCase` puts its own confirmation in the body: the thing being confirmed is
   * *this* policy, and a flag that travelled separately could confirm a draft the caller has since
   * changed.
   */
  readonly confirmedSelfLockout?: boolean;
  /** The caller's address, for the `CRITICAL` trail entry this action always writes. */
  readonly ipAddress: string | undefined;
}

export interface SecurityPolicyResult {
  readonly policy: SharedOrganization.SecurityPolicy;
}

/**
 * Writing the organization's second-factor policy (STORY-013-05, acceptance 1, 7 and 8).
 *
 * ## The dates are computed here, not sent by the client
 *
 * `mfaRequiredSince` records when each role entered the policy, and it is the field acceptance 5
 * rests on. A role that was already in the policy keeps the date it had; a role being added gets
 * `now`; a role being removed loses its entry. A client that could send these dates could hand
 * itself a grace period that expired last year — or, more likely, hand everybody a fresh one by
 * accident on every save, which is a policy that never starts being enforced.
 *
 * ## Every role reference is resolved against this tenant
 *
 * A uuid that names no role of this organization is refused as **404**, the same answer an id of
 * another organization gets — otherwise the endpoint would say whether a given role id exists
 * somewhere (CLAUDE.md, invariant 2). System role keys are checked against the shared catalogue by
 * the schema, which is closed.
 *
 * ## The self-lockout confirmation (acceptance 7)
 *
 * A person who writes a policy covering a role *they* hold, without having a second factor
 * themselves, is arranging their own lockout: their grace period is the one they just set, and when
 * it runs out their next session reaches nothing but the enrolment wizard. That is a legitimate
 * thing to do — it is how an owner rolls the policy out to themselves — so it is refused once with
 * **428 `confirmation_required`** and allowed on the repeat, rather than blocked.
 *
 * **There is no rescue path if they then lose the authenticator, and that is worth stating plainly.**
 * The account is not locked out of the *product* — it can still enrol a new authenticator, because
 * the enrolment routes are exactly what the scoped session reaches. What it cannot do is enrol
 * without being able to sign in, and it can always sign in: the password is unchanged and the
 * scoped session is a real session. The failure that has no in-product remedy is a *different* one —
 * an account that already had a second factor, lost the authenticator and has no recovery codes, and
 * whose organization has nobody else holding `user:reset_mfa`. That one is the operator's, through
 * `docs/runbooks/incident.md`, and this operation does not create it: it can only ever require a
 * factor that is not yet set up, which is a state its own routes can leave.
 *
 * No capability check in this body: whether the caller holds
 * `organization:manage_security_policy` is the guard's question and it already answered it. The
 * route carries no `:id`, so there is no object to answer 404 for — the same shape as
 * `TransferOwnershipUseCase` (`rules/permissions.mdc`, 3; `test/contract/acl-coverage.test.ts`).
 */
export class UpdateSecurityPolicyUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly organizations: OrganizationRepositoryPort,
    private readonly roles: CustomRoleRepositoryPort,
    private readonly policyReader: MfaPolicyReaderPort,
    private readonly enrollment: TotpEnrollmentRepositoryPort,
    private readonly clock: ClockPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: UpdateSecurityPolicyInput): Promise<SecurityPolicyResult> {
    return await this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const settings = await this.organizations.readSettings();
        const before = SharedOrganization.readSecurityPolicy(settings);

        await this.assertRolesExist(input.mfaRequiredForRoles);

        const after = SharedOrganization.securityPolicySchema.parse({
          mfaRequiredForRoles: [...input.mfaRequiredForRoles],
          mfaGracePeriodDays: input.mfaGracePeriodDays,
          mfaRequiredSince: this.requiredSince(before, input.mfaRequiredForRoles),
        });

        await this.assertNotBlindSelfLockout(input, after);

        await this.organizations.writeSettings(
          SharedOrganization.writeSecurityPolicy(settings, after),
        );

        await this.audit.record({
          action: 'organization.security_policy_updated',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: input.ipAddress,
          },
          target: { type: 'ORGANIZATION', id: input.actor.organizationId },
          before: { ...before },
          after: { ...after },
          requestId: undefined,
        });

        return { policy: after };
      },
    );
  }

  /**
   * The start date of every named role: kept for a role that was already covered, `now` for one
   * being added.
   *
   * Keeping the old date is what stops an edit of the grace period from restarting everybody's
   * countdown — the change an administrator makes most often, and the one that would silently
   * un-enforce a policy that had just come into force.
   */
  private requiredSince(
    before: SharedOrganization.SecurityPolicy,
    next: readonly string[],
  ): Record<string, string> {
    const now = this.clock.now().toISOString();

    return Object.fromEntries(next.map((ref) => [ref, before.mfaRequiredSince[ref] ?? now]));
  }

  /**
   * Refuses a uuid that names no role of this tenant, as 404.
   *
   * A reference is a custom role id exactly when it is not one of the seven system keys — tested
   * against the closed list rather than by the shape of the string, because «looks like a uuid» is
   * a guess and `SYSTEM_ROLE_KEYS` is the thing the schema already accepted it as.
   */
  private async assertRolesExist(refs: readonly string[]): Promise<void> {
    const system = new Set<string>(SharedPermissions.SYSTEM_ROLE_KEYS);
    const ids = refs.filter((ref) => !system.has(ref));

    if (ids.length === 0) return;

    const known = new Set((await this.roles.list()).map((role) => role.roleId));

    if (ids.some((id) => !known.has(id))) throw denyAccess('role', 'other_organization');
  }

  /**
   * Acceptance 7: the caller is about to put themselves under a requirement they do not meet.
   *
   * Read from the caller's own rows rather than from the request: the question is whether *this
   * person* is covered by the policy being written, and by the dates it will actually be stored
   * with. Two statements, on an operation that happens a handful of times in the life of an
   * installation.
   */
  private async assertNotBlindSelfLockout(
    input: UpdateSecurityPolicyInput,
    after: SharedOrganization.SecurityPolicy,
  ): Promise<void> {
    if (input.confirmedSelfLockout === true) return;

    const [enrolled, roles] = await Promise.all([
      this.enrollment.find(input.actor.userId),
      this.policyReader.roleGrantsOf(input.actor.userId),
    ]);

    // Already has a second factor: the policy asks nothing new of them, whatever it covers.
    if (enrolled !== null && enrolled.enabledAt !== null) return;

    const verdict = evaluateMfaRequirement({
      policy: after,
      roles,
      hasSecondFactor: false,
      now: this.clock.now(),
    });

    if (!verdict.covered) return;

    throw new ConfirmationRequiredError({
      reason: 'mfa_policy_self_lockout',
      graceEndsAt:
        verdict.graceEndsAtMs === undefined
          ? undefined
          : new Date(verdict.graceEndsAtMs).toISOString(),
    });
  }
}
