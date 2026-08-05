import { type RequestHandler } from 'express';

import { type AssignRoleUseCase } from '@/application/iam/use-cases/assign-role.use-case.js';
import { type RevokeRoleUseCase } from '@/application/iam/use-cases/revoke-role.use-case.js';
import { readActor } from '@/presentation/http/middleware/require-permission.middleware.js';
import { type RequestValidator } from '@/presentation/http/middleware/validate.middleware.js';
import {
  type assignRoleBodySchema,
  type userIdParamsSchema,
  type userRoleParamsSchema,
} from '@/presentation/http/validators/user-role.validator.js';

export interface UserRoleControllerDependencies {
  readonly assignRole: AssignRoleUseCase;
  readonly revokeRole: RevokeRoleUseCase;
  readonly assignValidator: RequestValidator<{
    params: typeof userIdParamsSchema;
    body: typeof assignRoleBodySchema;
  }>;
  readonly revokeValidator: RequestValidator<{ params: typeof userRoleParamsSchema }>;
}

/**
 * Giving somebody a role, and taking it back.
 *
 * The handlers are wiring and nothing else: they read the actor the permission guard built, hand it
 * to a use-case with the two ids, and translate the result into a status. **No handler decides who
 * may do this** — the escalation rules, the last owner and the self-lockout live in
 * `role-assignment.policy.ts`, called from the use-case, which is where invariant 2 of CLAUDE.md
 * requires the authoritative check to be.
 *
 * Both operations answer **204** and carry no body. What a client would do with one — refresh the
 * person's role list — is a read it makes anyway, and returning the assignment would invite the
 * client to trust a copy of state that the next request may already contradict.
 */
export const createUserRoleController = (
  dependencies: UserRoleControllerDependencies,
): {
  readonly assign: RequestHandler;
  readonly revoke: RequestHandler;
} => ({
  assign: async (_request, response) => {
    const { params, body } = dependencies.assignValidator.read(response);
    const actor = readActor(response);

    await dependencies.assignRole.execute({
      actor,
      userId: params.userId,
      roleId: body.roleId,
      // `null` and «absent» mean the same thing — until revoked — and the schema allows both because
      // a client that clears the field sends `null` while one that never set it omits the key.
      expiresAt: body.expiresAt === undefined || body.expiresAt === null ? null : new Date(body.expiresAt),
    });

    // 204 whether the row was created now or existed already: the caller asked for a state, and the
    // state is there. A 200-versus-201 distinction would leak whether somebody else had already made
    // the same assignment, which is not information this operation is about.
    response.status(204).send();
  },

  revoke: async (_request, response) => {
    const { params } = dependencies.revokeValidator.read(response);
    const actor = readActor(response);

    await dependencies.revokeRole.execute({
      actor,
      userId: params.userId,
      roleId: params.roleId,
    });

    response.status(204).send();
  },
});
