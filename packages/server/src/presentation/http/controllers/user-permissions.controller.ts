import { type RequestHandler } from 'express';

import { type GetUserPermissionsQuery } from '@/application/iam/use-cases/get-user-permissions.query.js';
import { readActor } from '@/presentation/http/middleware/require-permission.middleware.js';
import { type RequestValidator } from '@/presentation/http/middleware/validate.middleware.js';
import { serializeUserPermissions } from '@/presentation/http/serializers/user-permissions.serializer.js';
import { type userPermissionsParamsSchema } from '@/presentation/http/validators/user-permissions.validator.js';

export interface UserPermissionsControllerDependencies {
  readonly getUserPermissions: GetUserPermissionsQuery;
  readonly validator: RequestValidator<{ params: typeof userPermissionsParamsSchema }>;
}

/**
 * What one person may do, with the origin of every answer.
 *
 * `Cache-Control: private, no-store`, where `/me/permissions` next door carries an `ETag` and
 * `must-revalidate`. The difference is not an oversight in either direction. That one is asked
 * before nearly every render, so a validator built from `permissionsVersion` turns most of those
 * asks into a 304 — worth the second place the tag is spelled out. This one is opened deliberately,
 * by one administrator, a few times a day; a conditional request would save nothing anybody has
 * measured, and the body carries the sentences administrators write about their colleagues, which is
 * not something to leave in a disk cache for the next person at the machine.
 *
 * Wiring only. Who may ask is `permission-inspection.policy.ts`, called from the query.
 */
export const createUserPermissionsController = (
  dependencies: UserPermissionsControllerDependencies,
): { readonly read: RequestHandler } => ({
  read: async (_request, response) => {
    const { params } = dependencies.validator.read(response);

    const permissions = await dependencies.getUserPermissions.execute({
      actor: readActor(response),
      subjectUserId: params.userId,
    });

    response.setHeader('Cache-Control', 'private, no-store');
    response.status(200).json(serializeUserPermissions(permissions));
  },
});
