import { type UserRoleRepositoryPort } from '@/application/iam/ports/user-role-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';
import { canAssignRole } from '@/domain/iam/access/role-assignment.policy.js';

export interface AssignRoleInput {
  readonly actor: Actor;
  readonly userId: string;
  readonly roleId: string;
  readonly expiresAt: Date | null;
}

export interface AssignRoleResult {
  /** `false` when the person already held it — the same assignment, answered the same way. */
  readonly created: boolean;
}

/**
 * Gives a person a role, or confirms they already have it.
 *
 * ## The order of the checks is the security property
 *
 * 1. **The subject and the role are resolved first**, and a missing one is a **404** — before any
 *    policy runs. A 403 here would answer «that id exists, you just may not touch it» about an
 *    organization the caller cannot see (invariant 2 of CLAUDE.md).
 * 2. **Then the policy**, which is where the escalation rules live: a role may only be granted by
 *    somebody who already holds everything it grants, and never to oneself (`T-IAM-09`).
 * 3. **Then the write**, the version bump and the trail — all three in the transaction this
 *    use-case opened, so a failure leaves none of them.
 *
 * ## Why the version bump is here and not in the repository
 *
 * `permissionsVersion` is what makes a change of roles take effect on the **next request** instead
 * of the next sign-in: it travels in the access token and is compared with the row. Bumping it is
 * part of the decision «the rights of this person changed», which is knowledge this layer has and
 * the repository does not — the repository would have to bump it on every write, including the ones
 * that changed nothing.
 *
 * Nothing happens when the person already holds the role: no version bump (every request they have
 * in flight would be invalidated for nothing) and no trail entry (an event that did not happen).
 */
export class AssignRoleUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly userRoles: UserRoleRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: AssignRoleInput): Promise<AssignRoleResult> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const role = await this.userRoles.roleFacts(input.roleId);

        if (role === null || !(await this.userRoles.userExists(input.userId))) {
          throw denyAccess('role', 'other_organization');
        }

        const rolesAfter = [...(await this.userRoles.roleIdsOf(input.userId)), input.roleId];

        assertAllowed(
          canAssignRole(input.actor, role, { userId: input.userId, rolesAfter }),
          'role',
        );

        const { created } = await this.userRoles.assign({
          userId: input.userId,
          roleId: input.roleId,
          grantedById: input.actor.userId,
          expiresAt: input.expiresAt,
        });

        if (!created) return { created };

        await this.userRoles.bumpPermissionsVersion(input.userId);
        await this.audit.record({
          action: 'role.assigned',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'USER_ROLE', id: input.userId },
          // The key, not only the id: a trail entry that says «role 7f3a…» is unreadable a year
          // later, and the role it names may have been deleted by then.
          after: {
            roleKey: role.key,
            roleId: role.roleId,
            expiresAt: input.expiresAt?.toISOString() ?? null,
          },
          requestId: undefined,
        });

        return { created };
      },
    );
  }
}
