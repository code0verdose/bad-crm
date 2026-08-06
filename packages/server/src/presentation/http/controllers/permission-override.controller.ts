import { type RequestHandler } from 'express';
import { type SharedPermissions } from '@bad-crm/shared';

import { type RemovePermissionOverrideUseCase } from '@/application/iam/use-cases/remove-permission-override.use-case.js';
import { type WritePermissionOverrideUseCase } from '@/application/iam/use-cases/write-permission-override.use-case.js';
import { readActor } from '@/presentation/http/middleware/require-permission.middleware.js';
import { type RequestValidator } from '@/presentation/http/middleware/validate.middleware.js';
import {
  type overrideParamsSchema,
  type writeOverrideBodySchema,
} from '@/presentation/http/validators/permission-override.validator.js';

export interface PermissionOverrideControllerDependencies {
  readonly writeOverride: WritePermissionOverrideUseCase;
  readonly removeOverride: RemovePermissionOverrideUseCase;
  readonly writeValidator: RequestValidator<{
    params: typeof overrideParamsSchema;
    body: typeof writeOverrideBodySchema;
  }>;
  readonly removeValidator: RequestValidator<{ params: typeof overrideParamsSchema }>;
}

/**
 * One exception, addressed by the person and the permission it is about.
 *
 * `PUT` rather than `POST`: the pair identifies the row (`uq_user_permission_overrides`), so writing
 * the same exception twice is the same exception — the shape of the URL says so, and the client does
 * not have to know whether it is creating or replacing.
 *
 * Handlers are wiring. Who may write an exception, on whom, and about what is decided by
 * `permission-override.policy.ts`, called from the use-case.
 */
export const createPermissionOverrideController = (
  dependencies: PermissionOverrideControllerDependencies,
): {
  readonly write: RequestHandler;
  readonly remove: RequestHandler;
} => ({
  write: async (_request, response) => {
    const { params, body } = dependencies.writeValidator.read(response);

    await dependencies.writeOverride.execute({
      actor: readActor(response),
      userId: params.userId,
      permissionKey: params.permission as SharedPermissions.PermissionKey,
      effect: body.effect,
      reason: body.reason,
      expiresAt:
        body.expiresAt === undefined || body.expiresAt === null ? null : new Date(body.expiresAt),
    });

    response.status(204).send();
  },

  remove: async (_request, response) => {
    const { params } = dependencies.removeValidator.read(response);

    await dependencies.removeOverride.execute({
      actor: readActor(response),
      userId: params.userId,
      permissionKey: params.permission as SharedPermissions.PermissionKey,
    });

    response.status(204).send();
  },
});
