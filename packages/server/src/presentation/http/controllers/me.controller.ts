import { type RequestHandler } from 'express';

import { type GetMyPermissionsQuery } from '@/application/iam/use-cases/get-my-permissions.query.js';
import { readCaller } from '@/presentation/http/middleware/authenticate.middleware.js';

export interface MeControllerDependencies {
  readonly getMyPermissions: GetMyPermissionsQuery;
}

/**
 * The caller's own permissions, with a validator built in: the version.
 *
 * `ETag: "perm-<userId>-<version>"` is not a hash of the body but the identity of the decision that
 * produced it. `permissionsVersion` is bumped inside the transaction of every change to somebody's
 * rights, so a stale copy is impossible by construction rather than by a timeout: the tag changes at
 * the same moment the answer does, and the client's `If-None-Match` misses on the very next request.
 *
 * `private, must-revalidate` for the same reason: this body belongs to one person, and a shared
 * cache holding it would hand one person's rights to another. Revalidation is cheap — a 304 costs
 * one read of the version — and staleness here is a screen offering a button the server will refuse.
 */
export const createMeController = (
  dependencies: MeControllerDependencies,
): { readonly permissions: RequestHandler } => ({
  permissions: async (request, response) => {
    const caller = readCaller(response);
    const permissions = await dependencies.getMyPermissions.execute({
      userId: caller.userId,
      organizationId: caller.organizationId,
    });
    const etag = `"perm-${caller.userId}-${String(permissions.version)}"`;

    response.setHeader('ETag', etag);
    response.setHeader('Cache-Control', 'private, must-revalidate');

    if (request.headers['if-none-match'] === etag) {
      response.status(304).end();

      return;
    }

    response.status(200).json(permissions);
  },
});
