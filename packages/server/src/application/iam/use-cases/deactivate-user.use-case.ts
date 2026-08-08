import { type EffectivePermissionsReaderPort } from '@/application/iam/ports/effective-permissions-reader.port.js';
import { type UserLifecycleRepositoryPort } from '@/application/iam/ports/user-lifecycle-repository.port.js';
import { type SessionRepositoryPort } from '@/application/identity/ports/session-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertDeactivable } from '@/domain/iam/access/user-lifecycle.policy.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

/**
 * A step of offboarding this installation cannot perform yet, and why.
 *
 * The report names these instead of reporting them as zero, and the difference is the whole point of
 * the story: «revoked 0 secure links» claims we looked, `pending` says we could not. An offboarding
 * report that quietly counts absent subsystems as done is exactly the «кажется, всё отключили» this
 * operation exists to replace.
 *
 * Each entry disappears the day its subsystem lands, and the story that lands it is named here so the
 * removal is not left to memory.
 */
export const PENDING_OFFBOARDING_STEPS = [
  /** Project membership arrives with EPIC-014; there is no `project_members` table yet. */
  'projectsLeft',
  /** Live sockets arrive with EPIC-025 (M5): nothing to disconnect while there is no realtime. */
  'socketsClosed',
  /** Secure links arrive with EPIC-036 (M7). */
  'linksRevoked',
  /**
   * Vault membership arrives with EPIC-035 (M7). It will stay on this list longer than the others:
   * removing a membership does **not** take back keys already downloaded, so the honest report will
   * say «rotation required» rather than «revoked» (`T-VAULT-05`, `RR-04`).
   */
  'vaultMembershipsFlagged',
] as const;

export type PendingOffboardingStep = (typeof PENDING_OFFBOARDING_STEPS)[number];

/** What one deactivation actually did, as counts of rows rather than as reassurance. */
export interface OffboardingReport {
  readonly userId: string;
  /** `true` when the account was already off: the operation is idempotent and nothing was written. */
  readonly alreadyDeactivated: boolean;
  readonly sessionsRevoked: number;
  readonly teamsLeft: number;
  /** Steps no subsystem exists for yet — named, never counted as zero. */
  readonly pending: readonly PendingOffboardingStep[];
}

export interface DeactivateUserInput {
  readonly actor: Actor;
  readonly subjectUserId: string;
  /** Free text for the trail. Never shown to the person being deactivated. */
  readonly reason: string;
}

/**
 * Switching an employee off — one operation, one transaction, one report.
 *
 * **Access stops at once, by three independent facts.** Every authenticated request re-reads the
 * session and requires all three: the session not revoked, `users.status = 'ACTIVE'`, and the token's
 * `permissionsVersion` equal to the row's (`AuthenticateSessionQuery`). This operation breaks all
 * three in the same transaction, so a token minted a minute ago and valid for fourteen more stops
 * working on the next request rather than at expiry — which is the mitigation `T-IAM-06` asks for.
 * Relying on any single one of them would be a design where a bug in one is a silent bypass.
 *
 * **Nothing is deleted.** The account is suspended, never removed: tasks, hours, invoices and the
 * audit trail keep pointing at a person who really did that work (NFR-12). What is removed is
 * membership — teams the person is no longer in — because that is access, not history.
 *
 * **Repeating it is not an error and not a second trail entry.** An offboarding is often run twice,
 * by two people, and the second run must not read in the log as a second event.
 *
 * **What the subject may do is read here, in the same transaction, and for one purpose**: the subset
 * rule of `assertDeactivable`. It is read through the same port every other subset rule reads
 * (`EffectivePermissionsReaderPort`) rather than folded a second time in the lifecycle repository —
 * a second place that turns rows into capabilities is a second answer to «what may this person do»,
 * and the two would drift on the first change to expiry or to overrides.
 */
export class DeactivateUserUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly lifecycle: UserLifecycleRepositoryPort,
    private readonly sessions: SessionRepositoryPort,
    private readonly permissions: EffectivePermissionsReaderPort,
    private readonly audit: AuditLoggerPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(input: DeactivateUserInput): Promise<OffboardingReport> {
    return await this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const subject = await this.lifecycle.byId(input.subjectUserId);

        // Not in this organization: 404, like every other object of somebody else's tenant. Before
        // the policy, so that a cross-tenant id cannot be told apart from a non-existent one by
        // which refusal comes back.
        if (subject === null) throw denyAccess('user', 'other_organization');

        // Read after the row and before the policy: an account the lifecycle reader could not find
        // is a 404 whatever its capabilities are, and the two reads happen inside the transaction
        // that writes, so a role granted mid-offboarding cannot slip past the subset rule.
        const facts = await this.permissions.capabilitiesOf(subject.userId);

        if (facts === null) throw denyAccess('user', 'other_organization');

        assertDeactivable(input.actor, {
          userId: subject.userId,
          organizationOwnerId: subject.organizationOwnerId,
          permissions: facts.granted,
          denied: facts.denied,
        });

        if (subject.status === 'SUSPENDED') {
          return {
            userId: subject.userId,
            alreadyDeactivated: true,
            sessionsRevoked: 0,
            teamsLeft: 0,
            pending: PENDING_OFFBOARDING_STEPS,
          };
        }

        const now = this.clock.now();
        const teams = await this.lifecycle.suspend(subject.userId, now);
        const sessionsRevoked = await this.sessions.revokeAllFamilies(
          subject.userId,
          'OFFBOARDING',
          now,
        );

        await this.audit.record({
          action: 'user.suspended',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'USER', id: subject.userId },
          before: { status: subject.status },
          // The counters are the report, and the trail carries the same ones: a reviewer asking «was
          // that offboarding complete» must not have to take the API response on faith.
          //
          // `teams` goes further than a counter, and it has to: those rows are deleted outright —
          // `team_members` has no `deleted_at` — and `teamRole` disappears with them. Reactivation
          // deliberately restores no membership, so whoever grants them again tomorrow needs a
          // record of *what* to grant, and the trail is the only place one can survive. A team id
          // and a role, both already visible to anybody who can read this entry: no personal data
          // is added by writing them down (`rules/observability.mdc`, 16).
          after: {
            status: 'SUSPENDED',
            reason: input.reason,
            sessionsRevoked,
            teamsLeft: teams.length,
            teams,
          },
          requestId: undefined,
        });

        return {
          userId: subject.userId,
          alreadyDeactivated: false,
          sessionsRevoked,
          teamsLeft: teams.length,
          pending: PENDING_OFFBOARDING_STEPS,
        };
      },
    );
  }
}
