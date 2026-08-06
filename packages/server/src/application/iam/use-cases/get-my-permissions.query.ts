import { type SharedPermissions } from '@bad-crm/shared';

import { type BuildActorQuery } from '@/application/iam/use-cases/build-actor.query.js';

export interface MyPermissions {
  readonly permissions: readonly SharedPermissions.PermissionKey[];
  readonly denied: readonly SharedPermissions.PermissionKey[];
  readonly roles: readonly string[];
  readonly isOwner: boolean;
  readonly version: number;
}

/**
 * What the caller may do, as the interface needs it — **their own permissions and nobody else's**.
 *
 * There is no `userId` parameter, and that is the design: an endpoint that took one would need a
 * capability to read somebody else's rights (`permission:override_read`), and the two questions
 * would then share a route whose authorization depends on an argument. Reading another person's
 * permissions is a different operation, on a different path, gated by that key — it arrives with the
 * administration screen that needs it.
 *
 * The client uses this to *hint*: hide a button, grey out a menu. The authority is always the
 * server, which checks again on the request the button would make — the list here is a copy of a
 * decision, and a copy can be stale by exactly one request.
 */
export class GetMyPermissionsQuery {
  constructor(private readonly buildActor: BuildActorQuery) {}

  async execute(input: { userId: string; organizationId: string }): Promise<MyPermissions> {
    const actor = await this.buildActor.execute(input);

    return {
      permissions: [...actor.permissions],
      denied: [...actor.denied],
      roles: actor.roleKeys,
      isOwner: actor.isOwner,
      version: actor.permissionsVersion,
    };
  }
}
