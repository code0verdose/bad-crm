import { type SharedPermissions } from '@bad-crm/shared';

import { type CustomRoleRepositoryPort } from '@/application/iam/ports/role-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import {
  canCreateRole,
  canUpdateRole,
  dangerousAmong,
} from '@/domain/iam/access/role-composition.policy.js';
import { ConfirmationRequiredError } from '@/domain/shared/errors/app.errors.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

export interface CreateCustomRoleInput {
  readonly actor: Actor;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly permissions: readonly SharedPermissions.PermissionKey[];
  /** The caller has seen the dangerous keys and repeated the request. */
  readonly confirmedDangerous: boolean;
}

export interface UpdateCustomRoleInput extends Omit<CreateCustomRoleInput, 'key'> {
  readonly roleId: string;
}

/** The role as it was stored — what the caller gets back instead of having to read it again. */
export interface CreatedRole {
  readonly roleId: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly permissions: readonly SharedPermissions.PermissionKey[];
}

/**
 * Creating a custom role: what an organization needed and the product does not ship.
 *
 * The escalation rule applies **here**, one step before assignment: a role nobody holds is still a
 * stored capability, and «create a role containing `user:impersonate`» plus any weakness in the
 * assignment path is a complete escalation. So the composition may only contain what the author
 * already holds.
 *
 * Dangerous keys need the caller to say so twice. Not because the second request is more
 * authorised — it is the same person with the same rights — but because the blast radius of
 * `user:impersonate` in a role is larger than the click that adds it looks, and 428 is the status a
 * client can act on by asking and repeating.
 */
export class CreateCustomRoleUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly roles: CustomRoleRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: CreateCustomRoleInput): Promise<CreatedRole> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const composition = {
          key: input.key,
          isSystem: false,
          permissions: input.permissions,
        };

        assertAllowed(canCreateRole(input.actor, composition), 'role');
        requireConfirmation(input.permissions, input.confirmedDangerous);

        const roleId = await this.roles.create({
          key: input.key,
          name: input.name,
          description: input.description,
          permissions: input.permissions,
        });

        await recordDangerous(this.audit, input.actor, roleId, input.permissions);

        await this.audit.record({
          action: 'role.created',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'ROLE', id: roleId },
          // The whole set, not the additions: «what does this role grant» has to be answerable from
          // one entry, and a delta forces a reader to replay the history to find out.
          after: { key: input.key, name: input.name, permissions: [...input.permissions] },
          requestId: undefined,
        });

        return {
          roleId,
          key: input.key,
          name: input.name,
          description: input.description,
          permissions: [...input.permissions],
        };
      },
    );
  }
}

/**
 * Changing what a role grants — replace, never merge.
 *
 * Two refusals beyond the capability, and both are about states that cannot be undone from inside:
 * a **system role** is code re-applied on upgrade, so editing it here would look like it worked and
 * disappear on the next release; and a change that removes the actor's own last way to edit roles is
 * refused, because the person who could put it back is the person who just lost the right.
 *
 * Everybody who holds the role has their permission version bumped in the same transaction, so the
 * change applies on their next request rather than at their next sign-in.
 */
export class UpdateCustomRoleUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly roles: CustomRoleRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: UpdateCustomRoleInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const before = await this.roles.composition(input.roleId);

        if (before === null) throw denyAccess('role', 'other_organization');

        assertAllowed(
          canUpdateRole(
            input.actor,
            { key: before.key, isSystem: before.isSystem, permissions: input.permissions },
            await this.actorAfterChange(input.actor, input.roleId),
          ),
          'role',
        );
        requireConfirmation(input.permissions, input.confirmedDangerous);

        const updated = await this.roles.update(input.roleId, {
          name: input.name,
          description: input.description,
          permissions: input.permissions,
        });

        // Deleted between the read above and this write: the same answer as for any role of another
        // organization, because from here the two are indistinguishable and both are «not there».
        if (!updated) throw denyAccess('role', 'other_organization');

        // Both of these are about the composition, not the request: a rename moves nobody's rights.
        // Bumping anyway would answer 401 to every holder at once and send them all into refresh
        // together — a load spike on the most sensitive endpoint, bought for nothing — and filing a
        // «dangerous key granted» entry would put an escalation in the trail that did not happen.
        if (!sameComposition(before.permissions, input.permissions)) {
          await this.roles.bumpHoldersOf(input.roleId);
          await recordDangerous(this.audit, input.actor, input.roleId, input.permissions);
        }

        await this.audit.record({
          action: 'role.updated',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'ROLE', id: input.roleId },
          // Both sides carry the name: a rename recorded only as «became X» leaves «from what?»
          // unanswerable without replaying the history.
          before: { key: before.key, name: before.name, permissions: [...before.permissions] },
          after: { key: before.key, name: input.name, permissions: [...input.permissions] },
          requestId: undefined,
        });
      },
    );
  }

  /** What the actor would still hold — read inside the transaction that is about to change it. */
  private async actorAfterChange(
    actor: Actor,
    roleId: string,
  ): Promise<{ holdsRole: boolean; keptElsewhere: ReadonlySet<SharedPermissions.PermissionKey> }> {
    const holdsRole = await this.roles.holdsRole(actor.userId, roleId);

    return {
      holdsRole,
      keptElsewhere: new Set(
        holdsRole ? await this.roles.permissionsExcludingRole(actor.userId, roleId) : [],
      ),
    };
  }
}

/**
 * The second entry, at `critical`, for a composition that contains a dangerous key.
 *
 * Beside `role.created`/`role.updated` rather than instead of them: severity comes from the action
 * and never from the call site, so «what happened to this role» and «who ever stored a dangerous
 * key» stay two answerable questions rather than one entry that means both.
 */
const recordDangerous = async (
  audit: AuditLoggerPort,
  actor: Actor,
  roleId: string,
  permissions: readonly SharedPermissions.PermissionKey[],
): Promise<void> => {
  const dangerous = dangerousAmong(permissions);

  if (dangerous.length === 0) return;

  await audit.record({
    action: 'role.dangerous_granted',
    actor: { userId: actor.userId, organizationId: actor.organizationId, ipAddress: undefined },
    target: { type: 'ROLE', id: roleId },
    after: { permissions: [...dangerous] },
    requestId: undefined,
  });
};

/** Whether the change moves what the role grants — the only kind of change that costs anybody a bump. */
const sameComposition = (
  before: readonly SharedPermissions.PermissionKey[],
  after: readonly SharedPermissions.PermissionKey[],
): boolean => {
  const kept = new Set(before);

  return before.length === after.length && after.every((permission) => kept.has(permission));
};

/** Dangerous keys are stored only when the caller repeated the request knowing which they are. */
const requireConfirmation = (
  permissions: readonly SharedPermissions.PermissionKey[],
  confirmed: boolean,
): void => {
  const dangerous = dangerousAmong(permissions);

  if (dangerous.length > 0 && !confirmed) {
    throw new ConfirmationRequiredError({ dangerous: [...dangerous] });
  }
};
