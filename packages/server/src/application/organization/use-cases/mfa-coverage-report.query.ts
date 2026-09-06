import { SharedOrganization } from '@bad-crm/shared';

import { type MfaPolicyReaderPort } from '@/application/organization/ports/mfa-policy-reader.port.js';
import { type MfaPolicyQuery } from '@/application/organization/use-cases/mfa-policy.query.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import {
  evaluateMfaRequirement,
  type MfaGate,
} from '@/domain/identity/access/mfa-requirement.policy.js';

export interface MfaCoverageReportInput {
  readonly actor: Actor;
  /**
   * The policy to report against, when it is a draft the caller has not saved (acceptance 2).
   *
   * Absent means the stored one (acceptance 9). The two are the same operation because they are the
   * same question asked twice — «who does this policy affect» — and answering the preview from a
   * different code path is how a confirmation dialog ends up naming people the enforcement does not.
   */
  readonly draft?: {
    readonly mfaRequiredForRoles: readonly string[];
    readonly mfaGracePeriodDays: number;
  };
}

/** One person on the report. */
export interface MfaCoverageRow {
  readonly userId: string;
  readonly email: string;
  readonly roleKeys: readonly string[];
  readonly gate: MfaGate;
  readonly graceEndsAt: string | undefined;
}

export interface MfaCoverageReport {
  readonly policy: SharedOrganization.SecurityPolicy;
  /** Everybody the policy names a role of, whether or not they have a second factor. */
  readonly covered: number;
  /** Of those, the ones who already have one. */
  readonly enrolled: number;
  /**
   * Every active account, with its verdict — the client filters and pages this in the URL
   * (`rules/lists-and-filters.mdc`), which it can only do over a list it has.
   *
   * Not paged on the server, deliberately: the report is bounded by the size of the organization
   * (5–50 people, `docs/product/prd.md`), it is read on one administration screen, and a page
   * cursor would make «how many are not enrolled» a second request that can disagree with the first.
   */
  readonly rows: readonly MfaCoverageRow[];
}

/**
 * Who the second-factor policy affects — the preview of acceptance 2 and the standing report of
 * acceptance 9, in one query.
 *
 * The verdict per person is `evaluateMfaRequirement`, the same function the login gate uses. That is
 * the property that matters: a report assembled from its own idea of «covered» would be a screen
 * that disagrees with the door.
 *
 * No capability check in this body: whether the caller holds
 * `organization:manage_security_policy` is the guard's question and it already answered it. The
 * route carries no `:id`, so there is no object to answer 404 for — the same shape as
 * `TransferOwnershipUseCase` (`rules/permissions.mdc`, 3; `test/contract/acl-coverage.test.ts`).
 */
export class MfaCoverageReportQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly reader: MfaPolicyReaderPort,
    private readonly policies: MfaPolicyQuery,
    private readonly clock: ClockPort,
  ) {}

  async execute(input: MfaCoverageReportInput): Promise<MfaCoverageReport> {
    return await this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const stored = await this.policies.policy();
        const policy = this.draftPolicy(stored, input);
        const subjects = await this.reader.coverageSubjects();
        const now = this.clock.now();

        const rows = subjects.map((subject) => {
          const verdict = evaluateMfaRequirement({
            policy,
            roles: subject.roles,
            hasSecondFactor: subject.totpEnabledAt !== null,
            now,
          });

          return {
            userId: subject.userId,
            email: subject.email,
            roleKeys: subject.roles.map((role) => role.roleKey),
            gate: verdict.gate,
            graceEndsAt:
              verdict.graceEndsAtMs === undefined
                ? undefined
                : new Date(verdict.graceEndsAtMs).toISOString(),
          };
        });

        const covered = rows.filter((row) => row.gate !== 'not_covered');

        return {
          policy,
          covered: covered.length,
          enrolled: covered.filter((row) => row.gate === 'satisfied').length,
          rows,
        };
      },
    );
  }

  /**
   * The draft as it *would* be stored: roles already covered keep their date, new ones start now.
   *
   * The same arithmetic `UpdateSecurityPolicyUseCase.requiredSince` performs, and it has to be, or
   * the preview would show a grace period that the save then computes differently — the exact
   * mismatch a preview exists to rule out.
   */
  private draftPolicy(
    stored: SharedOrganization.SecurityPolicy,
    input: MfaCoverageReportInput,
  ): SharedOrganization.SecurityPolicy {
    if (input.draft === undefined) return stored;

    const now = this.clock.now().toISOString();

    return SharedOrganization.securityPolicySchema.parse({
      mfaRequiredForRoles: [...input.draft.mfaRequiredForRoles],
      mfaGracePeriodDays: input.draft.mfaGracePeriodDays,
      mfaRequiredSince: Object.fromEntries(
        input.draft.mfaRequiredForRoles.map((ref) => [ref, stored.mfaRequiredSince[ref] ?? now]),
      ),
    });
  }
}
