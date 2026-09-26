import { type SharedPermissions } from '@bad-crm/shared';

import { type AclRepositoryPort } from '@/application/access/ports/acl-repository.port.js';
import { type AclScopeResolver } from '@/application/access/use-cases/resolve-acl.query.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type AclResourceRef, type AclSubjectRef } from '@/domain/access/acl-chain.types.js';
import {
  errorResourceOfAclResource,
  errorResourceOfAclSubject,
} from '@/domain/access/acl-error-resource.util.js';
import { closeContourOf } from '@/domain/access/acl-contour.policy.js';
import { canGrantAcl } from '@/domain/access/acl-management.policy.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

export interface GrantAclInput {
  readonly actor: Actor;
  readonly resource: AclResourceRef;
  readonly subject: AclSubjectRef;
  readonly level: SharedPermissions.AccessLevel;
  readonly expiresAt: Date | null;
  /** The caller's address, for the `WARNING`-severity trail entry this action always writes. */
  readonly ipAddress: string | undefined;
}

export interface GrantAclResult {
  readonly id: string;
}

/**
 * Writes — or replaces — one grant on one object (STORY-011-06, acceptance 1).
 *
 * **Upsert, not insert**, for the reason `write-permission-override.use-case.ts` gives: one opinion
 * per (object, subject) is a property of the schema, so «somebody already decided otherwise» is
 * the previous state to record, not a conflict to report. The trail gets `before` and `after`.
 *
 * **The order is the security property.** The object is resolved and the policy runs first, so a
 * caller who may not grant on this project is refused before the subject is looked at — the grant
 * form must not be a way to learn whether a team id exists. The one read the policy itself may ask
 * for — whether a role or a team reaches the caller, for the self-lockout rule (the gate's L-2) —
 * comes after the conjunction holds and answers only about the caller's own memberships, so a
 * foreign id is «not reached» there and a 404 one step later. The subject is checked next, before
 * anything is written, and a subject of another organization is a 404 in the subject's own words
 * (`team_not_found`), never a 403. Only then the write, the version bump of everyone the grant
 * reaches, and the trail entry — all inside one scope, so a trail that cannot be written rolls the
 * grant back (`audit-logger.port.ts`: an action nobody could write down did not happen).
 *
 * The bump is what makes «немедленно» true for a team grant: a cached view of rights is dropped
 * for every member on their next request rather than on their next sign-in (STORY-012-07,
 * acceptance 3).
 */
export class GrantAclUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly resolver: AclScopeResolver,
    private readonly acl: AclRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: GrantAclInput): Promise<GrantAclResult> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const scope = await this.resolver.resolve(input.actor, input.resource);

        // The membership read is the policy's to ask for (the gate's L-2): only a grant below
        // `MANAGER` to a role or a team, from somebody who may grant, reaches the port at all.
        const decision = await canGrantAcl(
          input.actor,
          scope,
          { subject: input.subject, level: input.level, expiresAt: input.expiresAt },
          () => this.acl.subjectReaches(input.subject, input.actor.userId),
        );

        assertAllowed(
          closeContourOf(input.resource.type, decision),
          errorResourceOfAclResource(input.resource.type),
        );

        if (!(await this.acl.subjectExists(input.subject))) {
          throw denyAccess(errorResourceOfAclSubject(input.subject.type), 'other_organization');
        }

        const before = await this.acl.find(input.resource, input.subject);
        const id = await this.acl.upsert({
          resource: input.resource,
          subject: input.subject,
          level: input.level,
          expiresAt: input.expiresAt,
          grantedById: input.actor.userId,
        });

        await this.acl.bumpPermissionsVersionOf(await this.acl.subjectUserIds(input.subject));
        await this.audit.record({
          action: 'acl.granted',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: input.ipAddress,
          },
          target: { type: 'RESOURCE_ACL', id },
          ...(before === null
            ? {}
            : {
                before: {
                  accessLevel: before.level,
                  expiresAt: before.expiresAt?.toISOString() ?? null,
                },
              }),
          after: {
            resourceType: input.resource.type,
            resourceId: input.resource.id,
            subjectType: input.subject.type,
            subjectId: input.subject.id,
            accessLevel: input.level,
            expiresAt: input.expiresAt?.toISOString() ?? null,
          },
          requestId: undefined,
        });

        return { id };
      },
    );
  }
}
