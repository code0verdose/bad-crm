import {
  type AclListEntry,
  type AclRepositoryPort,
} from '@/application/access/ports/acl-repository.port.js';
import { type AclScopeResolver } from '@/application/access/use-cases/resolve-acl.query.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type AclResourceRef } from '@/domain/access/acl-chain.types.js';
import { errorResourceOfAclResource } from '@/domain/access/acl-error-resource.util.js';
import { closeContourOf } from '@/domain/access/acl-contour.policy.js';
import { canReadAcl } from '@/domain/access/acl-management.policy.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';

export interface ListResourceAclInput {
  readonly actor: Actor;
  readonly resource: AclResourceRef;
}

/**
 * Who holds what on one object — `GET /api/v1/acl?resourceType=&resourceId=`.
 *
 * `acl:read` and `VIEWER` on the object, the key decided before the object is resolved and the
 * object before a grant is read (`canReadAcl` takes the scope as a thunk). Refusals are coded on
 * the object — the caller addressed a project, and «not there» for it has to read as the project
 * card reads it (`project_not_found`), whether the id is unknown, another organization's, or a
 * `PRIVATE` project the caller is not on.
 *
 * **The list is of this object's rows only.** A grant on an ancestor reaches the object through
 * the chain and is shown on the ancestor's own list: answering the chain here would mean deciding,
 * per ancestor, whether the caller may see *its* grants — a second authorization walk on a read
 * that owes one. Expired grants are left out by the statement at the clock's instant, so the list
 * and the resolver agree on what is live.
 *
 * No pagination: an object carries a handful of grants, like a project roster carries a handful of
 * people (`GET /projects/{projectId}/members` answers `{ items }` for the same reason). The day an
 * object with thousands of grants is a real case, the list becomes a page — additively, as a new
 * optional query parameter.
 */
export class ListResourceAclQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly resolver: AclScopeResolver,
    private readonly acl: AclRepositoryPort,
    private readonly clock: ClockPort,
  ) {}

  execute(input: ListResourceAclInput): Promise<readonly AclListEntry[]> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        assertAllowed(
          closeContourOf(
            input.resource.type,
            await canReadAcl(input.actor, () => this.resolver.resolve(input.actor, input.resource)),
          ),
          errorResourceOfAclResource(input.resource.type),
        );

        return this.acl.listOn(input.resource, this.clock.now());
      },
    );
  }
}
