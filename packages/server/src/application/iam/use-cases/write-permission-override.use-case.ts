import { type SharedPermissions } from '@bad-crm/shared';

import {
  type OverrideEffect,
  type PermissionOverrideRepositoryPort,
} from '@/application/iam/ports/permission-override-repository.port.js';
import { type UserRoleRepositoryPort } from '@/application/iam/ports/user-role-repository.port.js';
import { type EffectivePermissionsReaderPort } from '@/application/iam/ports/effective-permissions-reader.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import { canWriteOverride } from '@/domain/iam/access/permission-override.policy.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

export interface WritePermissionOverrideInput {
  readonly actor: Actor;
  readonly userId: string;
  readonly permissionKey: SharedPermissions.PermissionKey;
  readonly effect: OverrideEffect;
  readonly reason: string;
  readonly expiresAt: Date | null;
}

/**
 * Writes — or replaces — one exception for one person.
 *
 * **Upsert, not insert.** One opinion per key is a property of the schema, so «somebody already
 * decided the opposite about this key» is not a conflict to report but the previous state to
 * record: the trail gets `before` and `after`, and the interface never has to explain why the same
 * form failed the second time.
 *
 * The order is the same as everywhere in this layer, and for the same reason: the subject is
 * resolved first, and a person who is not in this organization is a **404** before any policy runs.
 * Ownership of the subject is read here rather than passed in — it is the fact the `owner_immutable`
 * rule turns on, and a caller-supplied one would be a caller-supplied answer to «may I do this».
 */
export class WritePermissionOverrideUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly overrides: PermissionOverrideRepositoryPort,
    private readonly permissions: EffectivePermissionsReaderPort,
    private readonly userRoles: UserRoleRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: WritePermissionOverrideInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        if (!(await this.userRoles.userExists(input.userId))) {
          throw denyAccess('user', 'other_organization');
        }

        const facts = await this.permissions.capabilitiesOf(input.userId);

        if (facts === null) throw denyAccess('user', 'other_organization');

        const draft = { permissionKey: input.permissionKey, effect: input.effect };

        assertAllowed(
          canWriteOverride(input.actor, draft, {
            userId: input.userId,
            isOwner: facts.isOwner,
          }),
          'user',
        );

        const before = await this.overrides.find(input.userId, input.permissionKey);

        await this.overrides.upsert({
          userId: input.userId,
          permissionKey: input.permissionKey,
          effect: input.effect,
          reason: input.reason,
          expiresAt: input.expiresAt,
          grantedById: input.actor.userId,
        });

        await this.userRoles.bumpPermissionsVersion(input.userId);
        await this.audit.record({
          action: before === null ? 'permission.override.created' : 'permission.override.updated',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'USER_PERMISSION_OVERRIDE', id: input.userId },
          // The reason travels into the trail on purpose: «why did this person have that» is the
          // question the trail exists to answer, and the reason is the only field that answers it.
          ...(before === null
            ? {}
            : { before: { effect: before.effect, reason: before.reason } }),
          after: {
            permissionKey: input.permissionKey,
            effect: input.effect,
            reason: input.reason,
            expiresAt: input.expiresAt?.toISOString() ?? null,
          },
          requestId: undefined,
        });
      },
    );
  }
}
