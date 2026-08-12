import { type RequestHandler } from 'express';

import { type ConfirmTotpUseCase } from '@/application/identity/use-cases/confirm-totp.use-case.js';
import { type ReadRecoveryCodeStatusQuery } from '@/application/identity/use-cases/read-recovery-code-status.query.js';
import { type RegenerateRecoveryCodesUseCase } from '@/application/identity/use-cases/regenerate-recovery-codes.use-case.js';
import { type SetupTotpUseCase } from '@/application/identity/use-cases/setup-totp.use-case.js';
import { readCaller } from '@/presentation/http/middleware/authenticate.middleware.js';
import { type RequestValidator } from '@/presentation/http/middleware/validate.middleware.js';
import { clientOf } from '@/presentation/http/session-client.util.js';
import {
  serializeRecoveryCodesIssued,
  serializeRecoveryCodesStatus,
  serializeTotpSetup,
} from '@/presentation/http/serializers/mfa.serializer.js';
import {
  type confirmTotpBodySchema,
  type regenerateRecoveryCodesBodySchema,
} from '@/presentation/http/validators/mfa.validator.js';

/**
 * `POST /auth/2fa/setup`, `/confirm` and `/recovery-codes/regenerate` each answer with a secret in
 * the clear exactly once: a base32 secret and an `otpauth://` URI that *carries* that same secret, or
 * ten plaintext recovery codes. `Cache-Control: private, no-store` on all three, the identical header
 * `user-permissions.controller.ts` sets for a response with far less at stake — a browser or an
 * intermediate proxy caching one of these bodies would hand a second reader the exact material this
 * endpoint exists to show only once.
 */
const NO_STORE = 'private, no-store';

export interface MfaControllerDependencies {
  readonly setupTotp: SetupTotpUseCase;
  readonly confirmTotp: ConfirmTotpUseCase;
  readonly recoveryCodeStatus: ReadRecoveryCodeStatusQuery;
  readonly regenerateRecoveryCodes: RegenerateRecoveryCodesUseCase;
  readonly confirmTotpValidator: RequestValidator<{ body: typeof confirmTotpBodySchema }>;
  readonly regenerateRecoveryCodesValidator: RequestValidator<{
    body: typeof regenerateRecoveryCodesBodySchema;
  }>;
}

/**
 * Two-factor authentication: drafting, confirming and the recovery-code lifecycle around it.
 *
 * Thin by construction, like every controller in this codebase — the validator has already run, one
 * use-case is called, its result is serialized. The one thing every handler here shares is where the
 * actor comes from: `readCaller(response)`, never the request body, so a `userId` a caller might
 * submit is not merely ignored — the validators do not even declare the field
 * (STORY-013-01, acceptance 9).
 */
export const createMfaController = (
  dependencies: MfaControllerDependencies,
): {
  readonly setup: RequestHandler;
  readonly confirm: RequestHandler;
  readonly recoveryCodeStatus: RequestHandler;
  readonly regenerateRecoveryCodes: RequestHandler;
} => ({
  setup: async (_request, response) => {
    const caller = readCaller(response);

    const result = await dependencies.setupTotp.execute({
      actor: { organizationId: caller.organizationId, userId: caller.userId },
    });

    response.setHeader('Cache-Control', NO_STORE);
    response.json(serializeTotpSetup(result));
  },

  /**
   * Confirming ownership of the drafted secret. The recovery-code batch travels in the **same**
   * response as the 200 that reports 2FA as enabled — there is no second call that could be missed
   * (STORY-013-01, acceptance 2; STORY-013-02, acceptance 1).
   */
  confirm: async (request, response) => {
    const caller = readCaller(response);
    const { body } = dependencies.confirmTotpValidator.read(response);

    const result = await dependencies.confirmTotp.execute({
      actor: { organizationId: caller.organizationId, userId: caller.userId },
      code: body.code,
      currentPassword: body.currentPassword,
      ipAddress: clientOf(request).ipAddress,
    });

    response.setHeader('Cache-Control', NO_STORE);
    response.json(serializeRecoveryCodesIssued(result.recoveryCodes));
  },

  /**
   * `{ total, remaining }`, and never the plaintext codes again — the endpoint STORY-013-02
   * acceptance 2 describes as the answer to "the page was refreshed".
   */
  recoveryCodeStatus: async (_request, response) => {
    const caller = readCaller(response);

    const counts = await dependencies.recoveryCodeStatus.execute({
      organizationId: caller.organizationId,
      userId: caller.userId,
    });

    response.json(serializeRecoveryCodesStatus(counts));
  },

  regenerateRecoveryCodes: async (request, response) => {
    const caller = readCaller(response);
    const { body } = dependencies.regenerateRecoveryCodesValidator.read(response);

    const result = await dependencies.regenerateRecoveryCodes.execute({
      actor: { organizationId: caller.organizationId, userId: caller.userId },
      currentPassword: body.currentPassword,
      totpCode: body.totpCode,
      ipAddress: clientOf(request).ipAddress,
    });

    response.setHeader('Cache-Control', NO_STORE);
    response.json(serializeRecoveryCodesIssued(result.recoveryCodes));
  },
});
