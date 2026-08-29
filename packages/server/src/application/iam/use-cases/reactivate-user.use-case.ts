import { type EffectivePermissionsReaderPort } from '@/application/iam/ports/effective-permissions-reader.port.js';
import { type UserLifecycleRepositoryPort } from '@/application/iam/ports/user-lifecycle-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertReactivable } from '@/domain/iam/access/user-lifecycle.policy.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

export interface ReactivateUserInput {
  readonly actor: Actor;
  readonly subjectUserId: string;
  /**
   * The caller's address, for the `WARNING`-severity trail entry this action always writes on a
   * real reactivation. `undefined` when nothing reached the controller — the same shape
   * `ResetUserMfaInput.ipAddress` carries for the identical reason (`rules/observability.mdc`).
   */
  readonly ipAddress: string | undefined;
}

export interface ReactivationResult {
  readonly userId: string;
  /** `true` when the account was already on: repeating the operation writes nothing. */
  readonly alreadyActive: boolean;
  /**
   * Always `false`, and present so the answer states it rather than leaving it to a release note.
   *
   * Teams, projects and vault memberships are **not** restored. The screen says so before the
   * button is pressed, and the response says so after.
   */
  readonly membershipsRestored: false;
}

/**
 * Bringing an account back.
 *
 * **It is not the inverse of deactivation, and that is deliberate.** Reactivation restores the
 * ability to sign in and nothing else: the teams, projects and shared vaults the person was in stay
 * left. Restoring them automatically would mean re-granting access on the strength of a state that
 * was correct months ago — an access review that never happened. Somebody returning to the same job
 * gets the same memberships back by being added to them, by a person who decided so today.
 *
 * The version is incremented on the way back in as well as on the way out. Not symmetry for its own
 * sake: the account may have been suspended while a token was in flight, and a returning account
 * whose version never moved would accept that token as current.
 *
 * There is no self check here. Reactivating oneself is unreachable rather than forbidden — a
 * suspended account cannot authenticate, so nobody can be the actor of their own return.
 *
 * **`assertReactivable` bounds it the same way `assertDeactivable` bounds offboarding (`T-IAM-09`).**
 * `user:reactivate` is a capability, not a bound on *which* account it reaches: without the subset
 * check, one holder could bring back any suspended account, including one that outranks them and one
 * that was suspended during an incident specifically because it did. Read through the same port
 * `DeactivateUserUseCase` reads the subject's capabilities through
 * (`EffectivePermissionsReaderPort`), in the same transaction, for the same reason: a second place
 * that turns rows into capabilities is a second answer to «what may this person do», and the two
 * would drift on the first change to expiry or to overrides. The read has to work on a suspended
 * account — the whole point is bounding a return *from* suspension by what the account could still do
 * while suspended.
 *
 * The check runs before the idempotency branch below, not after: an actor whose own rights were
 * narrowed between two reactivation attempts must be refused on the second one too, exactly as
 * `DeactivateUserUseCase` refuses a second offboarding call under the same circumstance.
 *
 * **The idempotent branch writes the trail anyway, symmetrically with `DeactivateUserUseCase`'s
 * `alreadyDeactivated` branch and with `ResetUserMfaUseCase` (`37e7385`).** A holder of
 * `user:reactivate` without `employee:read` (independent keys in the catalogue; a custom role may
 * hold one without the other) has no route to an account's status but this one, and the response
 * already answers it on every call — `alreadyActive` is the report, not an optional courtesy. Leaving
 * the repeat unaudited would be the identical oracle `37e7385` closed, one route over. `before.status`
 * records what was actually found rather than assuming `ACTIVE`; nothing else about the account moved,
 * so `after` mirrors the response's `membershipsRestored: false`.
 */
export class ReactivateUserUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly lifecycle: UserLifecycleRepositoryPort,
    private readonly permissions: EffectivePermissionsReaderPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: ReactivateUserInput): Promise<ReactivationResult> {
    return await this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const subject = await this.lifecycle.byId(input.subjectUserId);

        // Not in this organization: 404, like every other object of somebody else's tenant. Before
        // the policy, so that a cross-tenant id cannot be told apart from a non-existent one by
        // which refusal comes back.
        if (subject === null) throw denyAccess('user', 'other_organization');

        // Read after the row and before the policy, inside the same transaction that writes — the
        // same ordering `DeactivateUserUseCase` uses and for the same reason: a role granted or
        // revoked mid-request cannot slip past the subset rule.
        const facts = await this.permissions.capabilitiesOf(subject.userId);

        if (facts === null) throw denyAccess('user', 'other_organization');

        assertReactivable(input.actor, {
          userId: subject.userId,
          permissions: facts.granted,
          denied: facts.denied,
        });

        if (subject.status !== 'SUSPENDED') {
          // Not a write to the row, but the trail records the attempt regardless — see the
          // docstring's account of `37e7385`: silence here is the same oracle on account status that
          // fix closed for 2FA, for a caller who holds `user:reactivate` without `employee:read`.
          await this.audit.record({
            action: 'user.reactivated',
            actor: {
              userId: input.actor.userId,
              organizationId: input.actor.organizationId,
              ipAddress: input.ipAddress,
            },
            target: { type: 'USER', id: subject.userId },
            before: { status: subject.status },
            after: { status: subject.status, membershipsRestored: false },
            requestId: undefined,
          });

          return { userId: subject.userId, alreadyActive: true, membershipsRestored: false };
        }

        await this.lifecycle.reactivate(subject.userId);

        await this.audit.record({
          action: 'user.reactivated',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: input.ipAddress,
          },
          target: { type: 'USER', id: subject.userId },
          before: { status: 'SUSPENDED' },
          // Recorded explicitly, because the reviewer's next question is «and what did they get back»
          // — the answer is «nothing but the ability to sign in», and the trail should not leave that
          // to be inferred.
          after: { status: 'ACTIVE', membershipsRestored: false },
          requestId: undefined,
        });

        return { userId: subject.userId, alreadyActive: false, membershipsRestored: false };
      },
    );
  }
}
