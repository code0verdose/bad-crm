import { type UserRoleRepositoryPort } from '@/application/iam/ports/user-role-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';
import { canRevokeRole } from '@/domain/iam/access/role-assignment.policy.js';

export interface RevokeRoleInput {
  readonly actor: Actor;
  readonly userId: string;
  readonly roleId: string;
}

export interface RevokeRoleResult {
  /** `false` when there was nothing to remove — the same end state, and not an error. */
  readonly removed: boolean;
}

/**
 * Takes a role away, unless doing so would leave nobody able to put it back.
 *
 * The two states an organization cannot recover from on its own are checked here rather than in the
 * repository, and both are counted **inside this transaction**:
 *
 * - **the last owner.** `countHoldersOfKey('owner', excluding the subject)` answers «how many owners
 *   would be left», not «how many are there now». Asked before the transaction, two concurrent
 *   revocations both see two owners, both proceed, and the organization ends with none — the classic
 *   read-then-write race, and the one place in this product where its result is unrecoverable;
 * - **the actor's own last role.** Refused, because the person who could undo it is the person who
 *   just lost the right to.
 *
 * A revocation of something the person did not hold is **not** an error: the caller asked for a state
 * and the state is already there. It writes no trail entry for the same reason the idempotent
 * assignment does not — nothing happened.
 */
export class RevokeRoleUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly userRoles: UserRoleRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: RevokeRoleInput): Promise<RevokeRoleResult> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const role = await this.userRoles.roleFacts(input.roleId);

        if (role === null || !(await this.userRoles.userExists(input.userId))) {
          throw denyAccess('role', 'other_organization');
        }

        const held = await this.userRoles.roleIdsOf(input.userId);
        const rolesAfter = held.filter((roleId) => roleId !== input.roleId);
        const ownersAfter = await this.userRoles.countHoldersOfKey('owner', input.userId);

        assertAllowed(
          canRevokeRole(input.actor, role, { userId: input.userId, rolesAfter }, ownersAfter),
          'role',
        );

        const removed = await this.userRoles.revoke(input.userId, input.roleId);

        if (!removed) return { removed };

        await this.userRoles.bumpPermissionsVersion(input.userId);
        await this.audit.record({
          action: 'role.revoked',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'USER_ROLE', id: input.userId },
          // `before`, not `after`: what the trail has to preserve is the state that stopped existing.
          before: { roleKey: role.key, roleId: role.roleId },
          requestId: undefined,
        });

        return { removed };
      },
    );
  }
}
