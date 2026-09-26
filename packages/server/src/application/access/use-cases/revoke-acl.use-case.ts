import {
  type AclEntryRow,
  type AclRepositoryPort,
} from '@/application/access/ports/acl-repository.port.js';
import { type AclScopeResolver } from '@/application/access/use-cases/resolve-acl.query.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { closeContourOf } from '@/domain/access/acl-contour.policy.js';
import { canRevokeAcl } from '@/domain/access/acl-management.policy.js';
import { accessErrorFor } from '@/domain/access/access.errors.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { type AclScope } from '@/domain/access/authorize.util.js';
import { assertAllowed } from '@/domain/access/decision.util.js';

export interface RevokeAclInput {
  readonly actor: Actor;
  /** The grant's own id — `DELETE /api/v1/acl/{aclId}`; the object and the subject are read from the row. */
  readonly aclId: string;
  readonly ipAddress: string | undefined;
}

/**
 * Takes one grant away, addressed by the grant's id.
 *
 * **The order is capability → row → object → level**, and the first step is the one that matters:
 * `canRevokeAcl` decides the key before its thunk runs, so a caller without `acl:revoke` is refused
 * before the row is read and gets the same answer for a real id and a made-up one. Only then is the
 * row looked up, and only then is the object it names resolved — the level is decided on what the
 * row says, never on anything the request could claim.
 *
 * **Every refusal is coded `acl_*`**, not on the object. The id names no object, so «there is no
 * such grant» (unknown, or another organization's — the tenant scope reads nothing of theirs) and
 * «there is such a grant on a project you cannot see» both arrive as a `missing` scope and leave as
 * one `404 acl_not_found`. Coding the second on the project would split them into two codes and
 * turn this route into a test of which grant ids exist. Inside the contour — the object is visible,
 * the level is short of `MANAGER` — the answer is `403 acl_forbidden`: the same caller can list the
 * grant with `GET /acl`, so its existence is no secret.
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
        const found: { row?: AclEntryRow } = {};

        const scopeOfGrant = async (): Promise<AclScope> => {
          const row = await this.acl.findById(input.aclId);

          if (row === null) return { status: 'missing' };

          found.row = row;

          return this.resolver.resolve(input.actor, row.resource);
        };

        const decision = await canRevokeAcl(input.actor, scopeOfGrant);

        // The project's closed contour applies to the object the row names — known only once the
        // row was read. Without a row the decision is already «not there» or a missing key.
        assertAllowed(
          found.row === undefined ? decision : closeContourOf(found.row.resource.type, decision),
          'acl',
        );

        // Set by `scopeOfGrant`: an allowed decision is one that asked the thunk, and the thunk only
        // resolves a scope — the one way to be allowed — after it found the row. No branch here,
        // because there is no state in which it could be taken.
        const existing = found.row as AclEntryRow;

        // By id, and only what the statement removed counts (the gate's L-1): a concurrent
        // revocation of the same grant leaves this one nothing to remove — the same 404 an unknown
        // id gets, and no second bump or trail entry for one grant.
        const removed = await this.acl.removeById(existing.id);

        if (removed === null) throw accessErrorFor('resource_not_found', 'acl');

        await this.acl.bumpPermissionsVersionOf(await this.acl.subjectUserIds(removed.subject));
        await this.audit.record({
          action: 'acl.revoked',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: input.ipAddress,
          },
          target: { type: 'RESOURCE_ACL', id: removed.id },
          before: {
            resourceType: removed.resource.type,
            resourceId: removed.resource.id,
            subjectType: removed.subject.type,
            subjectId: removed.subject.id,
            accessLevel: removed.level,
            expiresAt: removed.expiresAt?.toISOString() ?? null,
          },
          requestId: undefined,
        });
      },
    );
  }
}
