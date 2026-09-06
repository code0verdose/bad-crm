import { type AclRepositoryPort } from '@/application/access/ports/acl-repository.port.js';
import { type AclScopeResolver } from '@/application/access/use-cases/resolve-acl.query.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type AclResourceRef, type AclSubjectRef } from '@/domain/access/acl-chain.types.js';
import { errorResourceOfAclResource } from '@/domain/access/acl-error-resource.util.js';
import { canRevokeAcl } from '@/domain/access/acl-management.policy.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

export interface RevokeAclInput {
  readonly actor: Actor;
  readonly resource: AclResourceRef;
  readonly subject: AclSubjectRef;
  readonly ipAddress: string | undefined;
}

/**
 * Takes one grant away — the mirror of `GrantAclUseCase`, in the same order and for the same
 * reasons: the object and the policy first, then the row.
 *
 * A grant that is not there is answered as the **object's** 404 rather than a 409 or a 204: to a
 * caller who may not know either, «no such grant on this project» and «no such project» have to
 * read alike, and the object's sentence is the one both refusals share.
 *
 * The trail entry carries what was removed as `before`, because the row is gone: `resource_acl`
 * has no `deleted_at`, and this entry is the only record that the grant existed — the same choice
 * `team.deleted` makes for a roster.
 */
export class RevokeAclUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly resolver: AclScopeResolver,
    private readonly acl: AclRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: RevokeAclInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const scope = await this.resolver.resolve(input.actor, input.resource);
        const resource = errorResourceOfAclResource(input.resource.type);

        assertAllowed(canRevokeAcl(input.actor, scope), resource);

        const existing = await this.acl.find(input.resource, input.subject);

        if (existing === null) throw denyAccess(resource, 'other_organization');

        await this.acl.remove(input.resource, input.subject);
        await this.acl.bumpPermissionsVersionOf(await this.acl.subjectUserIds(input.subject));
        await this.audit.record({
          action: 'acl.revoked',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: input.ipAddress,
          },
          target: { type: 'RESOURCE_ACL', id: existing.id },
          before: {
            resourceType: input.resource.type,
            resourceId: input.resource.id,
            subjectType: input.subject.type,
            subjectId: input.subject.id,
            accessLevel: existing.level,
            expiresAt: existing.expiresAt?.toISOString() ?? null,
          },
          requestId: undefined,
        });
      },
    );
  }
}
