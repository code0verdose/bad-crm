import { type RequestHandler } from 'express';

import { type TransferOwnershipUseCase } from '@/application/iam/use-cases/transfer-ownership.use-case.js';
import { readActor } from '@/presentation/http/middleware/require-permission.middleware.js';
import { type RequestValidator } from '@/presentation/http/middleware/validate.middleware.js';
import { type transferOwnershipBodySchema } from '@/presentation/http/validators/ownership.validator.js';

export interface OwnershipControllerDependencies {
  readonly transferOwnership: TransferOwnershipUseCase;
  readonly transferValidator: RequestValidator<{ body: typeof transferOwnershipBodySchema }>;
}

/**
 * Handing the organization over.
 *
 * Wiring only. Who may receive it — not oneself, not a suspended account — is decided by
 * `ownership-transfer.policy.ts` from inside the use-case, where the recipient and the tenant root
 * are read in the same transaction that writes.
 */
export const createOwnershipController = (
  dependencies: OwnershipControllerDependencies,
): { readonly transfer: RequestHandler } => ({
  transfer: async (_request, response) => {
    const { body } = dependencies.transferValidator.read(response);

    const result = await dependencies.transferOwnership.execute({
      actor: readActor(response),
      toUserId: body.toUserId,
      previousOwnerRoleKey: body.previousOwnerRoleKey,
    });

    response.status(200).json(result);
  },
});
