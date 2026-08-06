import { type SharedPermissions } from '@bad-crm/shared';

import { type EffectivePermissionsReaderPort } from '@/application/iam/ports/effective-permissions-reader.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

export interface BuildActorInput {
  readonly userId: string;
  readonly organizationId: string;
}

/**
 * Turns an authenticated caller into an actor — the only thing the permission layer takes.
 *
 * The authentication guard answers «who is this»; this answers «what may they do», and the two are
 * separate on purpose. A token says what was true when it was issued: roles change, a role expires,
 * an assignment is revoked — and the acceptance criterion of STORY-011-04 is that the *next* request
 * runs with the new rights, without a re-login. That is only possible if the capability view is read
 * per request rather than carried in the token.
 *
 * **The cost is one indexed read, and it is not cached yet.** §8 of the permission model describes a
 * 60-second cache keyed by `permissionsVersion`; it is an optimisation with a correctness condition
 * (the version has to be bumped in the same transaction as every change, which it now is), and it
 * arrives with the first screen that makes the read hot. Caching before that would be a cache nobody
 * has measured the need for and everybody has to reason about.
 *
 * A caller whose account has disappeared between the token and this read is refused as **404** —
 * `denyAccess` with the scope that means «not yours, or not there», because those two must stay
 * indistinguishable from outside.
 */
export class BuildActorQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly permissions: EffectivePermissionsReaderPort,
  ) {}

  async execute(input: BuildActorInput): Promise<Actor> {
    return this.unitOfWork.withTenant(
      { organizationId: input.organizationId, userId: input.userId },
      async () => {
        const facts = await this.permissions.capabilitiesOf(input.userId);

        if (facts === null) throw denyAccess('user', 'other_organization');

        return {
          userId: input.userId,
          organizationId: input.organizationId,
          isOwner: facts.isOwner,
          permissionsVersion: facts.permissionsVersion,
          permissions: new Set<SharedPermissions.PermissionKey>(facts.granted),
          denied: new Set<SharedPermissions.PermissionKey>(facts.denied),
          roleKeys: facts.roleKeys,
        };
      },
    );
  }
}
