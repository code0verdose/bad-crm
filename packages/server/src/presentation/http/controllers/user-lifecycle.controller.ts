import { type RequestHandler } from 'express';

import { type DeactivateUserUseCase } from '@/application/iam/use-cases/deactivate-user.use-case.js';
import { type ReactivateUserUseCase } from '@/application/iam/use-cases/reactivate-user.use-case.js';
import { readActor } from '@/presentation/http/middleware/require-permission.middleware.js';
import { type RequestValidator } from '@/presentation/http/middleware/validate.middleware.js';
import {
  type deactivateUserBodySchema,
  type userLifecycleParamsSchema,
} from '@/presentation/http/validators/user-lifecycle.validator.js';

export interface UserLifecycleControllerDependencies {
  readonly deactivateUser: DeactivateUserUseCase;
  readonly reactivateUser: ReactivateUserUseCase;
  readonly deactivateValidator: RequestValidator<{
    params: typeof userLifecycleParamsSchema;
    body: typeof deactivateUserBodySchema;
  }>;
  readonly reactivateValidator: RequestValidator<{ params: typeof userLifecycleParamsSchema }>;
}

/**
 * Switching an account off and back on.
 *
 * Handlers are wiring. Which refusals apply — not yourself, not the last owner — is decided by
 * `user-lifecycle.policy.ts` from inside the use-case, where the subject and the organization are
 * read in the same transaction that writes.
 *
 * **200, not 204.** The answer is the report: an offboarding whose response carries no counters is
 * one the caller has to trust rather than check, and the whole story exists to replace «кажется, всё
 * отключили» with a list of what was actually revoked.
 */
export const createUserLifecycleController = (
  dependencies: UserLifecycleControllerDependencies,
): {
  readonly deactivate: RequestHandler;
  readonly reactivate: RequestHandler;
} => ({
  deactivate: async (_request, response) => {
    const { params, body } = dependencies.deactivateValidator.read(response);

    const report = await dependencies.deactivateUser.execute({
      actor: readActor(response),
      subjectUserId: params.userId,
      reason: body.reason,
    });

    response.status(200).json(report);
  },

  reactivate: async (_request, response) => {
    const { params } = dependencies.reactivateValidator.read(response);

    const result = await dependencies.reactivateUser.execute({
      actor: readActor(response),
      subjectUserId: params.userId,
    });

    response.status(200).json(result);
  },
});
