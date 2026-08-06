import { type SharedPermissions } from '@bad-crm/shared';

import { type CustomRoleRepositoryPort } from '@/application/iam/ports/role-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import { canDeleteRole } from '@/domain/iam/access/role-composition.policy.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

export interface DeleteCustomRoleInput {
  readonly actor: Actor;
  readonly roleId: string;
}

/**
 * Removes a custom role, and with it everything it granted to everybody who held it.
 *
 * The assignments go by `ON DELETE CASCADE`, which is the right shape — a role that no longer exists
 * cannot be held — but it means the people who held it lose those permissions at the same instant.
 * So their permission version is bumped in the same transaction: the loss applies on their next
 * request rather than at their next sign-in, which is the direction that matters when access is
 * being taken away.
 *
 * `before` in the trail carries the full composition, not the id. A year later «role 7f3a… deleted»
 * is unreadable, and the role it names is exactly the thing that no longer exists to be looked up.
 */
export class DeleteCustomRoleUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly roles: CustomRoleRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: DeleteCustomRoleInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const role = await this.roles.composition(input.roleId);

        if (role === null) throw denyAccess('role', 'other_organization');

        const [holdsRole, holderCount] = await Promise.all([
          this.roles.holdsRole(input.actor.userId, input.roleId),
          this.roles.holderCount(input.roleId),
        ]);

        assertAllowed(
          canDeleteRole(
            input.actor,
            { key: role.key, isSystem: role.isSystem, permissions: role.permissions },
            {
              holdsRole,
              keptElsewhere: new Set<SharedPermissions.PermissionKey>(
                holdsRole
                  ? await this.roles.permissionsExcludingRole(input.actor.userId, input.roleId)
                  : [],
              ),
            },
          ),
          'role',
        );

        // Before the removal, not after: the cascade takes the assignments with the role, and a
        // statement looking for holders afterwards would find none and invalidate nobody.
        await this.roles.bumpHoldersOf(input.roleId);
        await this.roles.remove(input.roleId);

        await this.audit.record({
          action: 'role.deleted',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'ROLE', id: input.roleId },
          before: {
            key: role.key,
            name: role.name,
            permissions: [...role.permissions],
            holders: holderCount,
          },
          requestId: undefined,
        });
      },
    );
  }
}
