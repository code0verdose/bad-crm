import { type RequestHandler, type Response } from 'express';
import { type SharedPermissions } from '@bad-crm/shared';

import { type BuildActorQuery } from '@/application/iam/use-cases/build-actor.query.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import { authorizeCapability } from '@/domain/access/authorize.util.js';
import { refusalResourceOf } from '@/domain/access/refusal-resource.util.js';
import { readCaller } from '@/presentation/http/middleware/authenticate.middleware.js';

/** Where the actor lives between the guard and the controller; a symbol, like the caller slot. */
const ACTOR = Symbol.for('bad-crm.actor');

type ActorLocals = Record<symbol, unknown>;

export interface PermissionGuardDependencies {
  readonly buildActor: BuildActorQuery;
}

/**
 * The capability half of a permission check — a fail-fast filter, never the authority.
 *
 * **What it does.** Builds the actor from the caller (roles as they are *now*, not as the token
 * remembers them) and refuses when the declared capability is absent. A caller without the right is
 * therefore stopped before the body is parsed and before any read of the resource.
 *
 * **What it deliberately does not do.** It does not resolve `:id` parameters and it does not check
 * the resource ACL. That decision belongs to the use-case, which is the only place that can also
 * answer **404** rather than 403 for an object of another organization — and `route-registry.types`
 * makes a route with an id parameter name the use-case where it happens (`aclCheckedIn`).
 *
 * Two points of authorization are what the model forbids; this is not the second one. It answers a
 * strictly weaker question — «may this caller do this *anywhere*» — and every route it lets through
 * is checked again where the object is known.
 */
export const createPermissionMiddleware = (
  dependencies: PermissionGuardDependencies,
  permission: SharedPermissions.PermissionKey,
): RequestHandler => {
  return async (_request, response, next) => {
    try {
      const caller = readCaller(response);
      const actor = await dependencies.buildActor.execute({
        userId: caller.userId,
        organizationId: caller.organizationId,
      });

      (response.locals as ActorLocals)[ACTOR] = actor;

      // The refusal is coded as the resource the permission is about — `role:assign` refuses as
      // `role_forbidden` — so the client translates the denial of *this* operation rather than a
      // generic one.
      assertAllowed(authorizeCapability(actor, permission), refusalResourceOf(permission));

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * The actor the guard built, for the controller that hands it to a use-case.
 *
 * Throws when the guard did not run, for the same reason `readCaller` does: a controller reading
 * this is behind a guarded route, and «no actor» is a wiring defect that must not quietly become an
 * anonymous request.
 */
export const readActor = (response: Response): Actor => {
  const actor = (response.locals as ActorLocals)[ACTOR];

  if (actor === undefined) {
    throw new Error(
      'require-permission.middleware: no actor — the route was mounted without the permission guard',
    );
  }

  return actor as Actor;
};
