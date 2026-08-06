import { type SharedPermissions } from '@bad-crm/shared';

import { type PermissionOverrideRepositoryPort } from '@/application/iam/ports/permission-override-repository.port.js';
import { type EffectivePermissionsReaderPort } from '@/application/iam/ports/effective-permissions-reader.port.js';
import { type UserRoleRepositoryPort } from '@/application/iam/ports/user-role-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import { canRemoveOverride } from '@/domain/iam/access/permission-override.policy.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

export interface RemovePermissionOverrideInput {
  readonly actor: Actor;
  readonly userId: string;
  readonly permissionKey: SharedPermissions.PermissionKey;
}

/**
 * Removes one exception, putting the person back on what their roles say.
 *
 * Removing an exception that is not there answers the same way as removing one that was: the caller
 * asked for a state, and the state is that no exception exists. Nothing is written to the trail in
 * that case, because nothing happened — the rule the assignment commands follow, for the same
 * reason.
 */
export class RemovePermissionOverrideUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly overrides: PermissionOverrideRepositoryPort,
    private readonly permissions: EffectivePermissionsReaderPort,
    private readonly userRoles: UserRoleRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: RemovePermissionOverrideInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const facts = await this.permissions.capabilitiesOf(input.userId);

        if (facts === null) throw denyAccess('user', 'other_organization');

        const existing = await this.overrides.find(input.userId, input.permissionKey);

        assertAllowed(
          canRemoveOverride(
            input.actor,
            { permissionKey: input.permissionKey, effect: existing?.effect ?? 'ALLOW' },
            { userId: input.userId, isOwner: facts.isOwner },
          ),
          'user',
        );

        if (existing === null) return;

        await this.overrides.remove(input.userId, input.permissionKey);
        await this.userRoles.bumpPermissionsVersion(input.userId);
        await this.audit.record({
          action: 'permission.override.deleted',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'USER_PERMISSION_OVERRIDE', id: input.userId },
          // `before` only: what the trail has to preserve is the exception that stopped existing,
          // together with the reason somebody once had for it.
          before: {
            permissionKey: existing.permissionKey,
            effect: existing.effect,
            reason: existing.reason,
          },
          requestId: undefined,
        });
      },
    );
  }
}
