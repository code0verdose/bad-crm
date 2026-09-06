import { SharedOrganization } from '@bad-crm/shared';

import { type MfaPolicyReaderPort } from '@/application/organization/ports/mfa-policy-reader.port.js';
import { type OrganizationRepositoryPort } from '@/application/organization/ports/organization-repository.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import {
  evaluateMfaRequirement,
  type MfaGate,
} from '@/domain/identity/access/mfa-requirement.policy.js';

/**
 * The domain verdict with its instant turned back into a `Date`.
 *
 * The conversion happens here rather than in `domain`, where `new Date(...)` is banned
 * (`test/unit/architecture/layers.test.ts`): a constructor that builds an instant from an argument
 * and one that builds it from the clock are the same call, and the ban cannot tell them apart.
 */
export interface MfaGateVerdict {
  readonly gate: MfaGate;
  readonly covered: boolean;
  readonly graceEndsAt: Date | undefined;
}

export interface MfaGateInput {
  readonly userId: string;
  /** Whether the account has a *confirmed* second factor — a draft secret is not one. */
  readonly hasSecondFactor: boolean;
}

/**
 * The one place the organization's second-factor policy is read and applied.
 *
 * Three callers need the same verdict and would otherwise each assemble it: `IssueSessionUseCase`
 * decides the token's scope with it (acceptance 3 and 4), `DisableTotpUseCase` refuses with it
 * (acceptance 6), and the coverage report renders it (acceptance 2 and 9). Three assemblies would
 * be three answers to «is Ivan required to enrol», and the first thing anybody would notice is a
 * screen calling somebody compliant while the login gate locks them out.
 *
 * **Everything here runs inside the tenant scope its caller opened** — the repositories resolve no
 * other way — which is what makes acceptance 11 structural rather than a check somebody remembers:
 * the policy of organization A is unreachable from a scope opened on B, because `settings` is a
 * column of the tenant root and the row is behind row-level security.
 *
 * ## What it costs
 *
 * Two statements: the `settings` column of the tenant root, and the subject's unexpired role grants.
 * They are **not** on the per-request path — `BuildActorQuery`'s eleven statements are, and this is
 * not beside them. `gateFor` runs when a session is *issued*: at sign-in, and at each refresh, which
 * is once per fifteen minutes per session. A guard that recomputed the verdict per request would
 * have put both reads on every request of every organization, including the ones that have no policy
 * at all, which is why the verdict rides in the token's `scope` claim instead (see
 * `AccessTokenClaims.mfaEnrollment`).
 */
export class MfaPolicyQuery {
  constructor(
    private readonly organizations: OrganizationRepositoryPort,
    private readonly roles: MfaPolicyReaderPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
  ) {}

  /**
   * The stored policy, or the disabled one.
   *
   * The parse failure is logged rather than raised — `readSecurityPolicy` explains why failing to
   * the disabled policy is the right direction — and logged **here** rather than swallowed inside
   * the schema, because a column that stopped parsing is an operational event somebody has to see:
   * the organization believes it has a policy and the product is not applying one.
   */
  async policy(): Promise<SharedOrganization.SecurityPolicy> {
    const settings = await this.organizations.readSettings();
    const policy = SharedOrganization.readSecurityPolicy(settings);

    if (
      settings !== null &&
      typeof settings === 'object' &&
      'securityPolicy' in settings &&
      policy === SharedOrganization.DISABLED_SECURITY_POLICY
    ) {
      this.logger.error(
        { event: 'organization.security_policy_unreadable' },
        'organizations.settings carries a securityPolicy this build cannot parse; treating the policy as off',
      );
    }

    return policy;
  }

  /** What the policy has to say about one person right now. */
  async gateFor(input: MfaGateInput): Promise<MfaGateVerdict> {
    const [policy, roles] = await Promise.all([
      this.policy(),
      this.roles.roleGrantsOf(input.userId),
    ]);

    const verdict = evaluateMfaRequirement({
      policy,
      roles,
      hasSecondFactor: input.hasSecondFactor,
      now: this.clock.now(),
    });

    return {
      gate: verdict.gate,
      covered: verdict.covered,
      graceEndsAt:
        verdict.graceEndsAtMs === undefined ? undefined : new Date(verdict.graceEndsAtMs),
    };
  }
}
