import { type RequestHandler } from 'express';

import { type ResetUserMfaUseCase } from '@/application/iam/use-cases/reset-user-mfa.use-case.js';
import { readActor } from '@/presentation/http/middleware/require-permission.middleware.js';
import { type RequestValidator } from '@/presentation/http/middleware/validate.middleware.js';
import { type resetUserMfaParamsSchema } from '@/presentation/http/validators/user-security.validator.js';

export interface UserSecurityControllerDependencies {
  readonly resetUserMfa: ResetUserMfaUseCase;
  readonly resetUserMfaValidator: RequestValidator<{ params: typeof resetUserMfaParamsSchema }>;
}

/**
 * Administrative actions over somebody else's account security, starting with the 2FA reset
 * (STORY-013-04, acceptance 5). Thin, like every controller in this codebase: the validator has
 * already run, one use-case is called, its result is serialized.
 *
 * **200, not 204** — the same choice `user-lifecycle.controller.ts` makes for the identical reason:
 * the answer is the report (sessions revoked, recovery codes deleted), and a response with no body
 * is one the caller has to trust rather than check.
 */
export const createUserSecurityController = (
  dependencies: UserSecurityControllerDependencies,
): {
  readonly resetMfa: RequestHandler;
} => ({
  resetMfa: async (_request, response) => {
    const { params } = dependencies.resetUserMfaValidator.read(response);

    const result = await dependencies.resetUserMfa.execute({
      actor: readActor(response),
      subjectUserId: params.userId,
    });

    response.status(200).json(result);
  },
});
