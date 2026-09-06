import { type RequestHandler } from 'express';

import { type MfaCoverageReportQuery } from '@/application/organization/use-cases/mfa-coverage-report.query.js';
import { type ReadSecurityPolicyQuery } from '@/application/organization/use-cases/read-security-policy.query.js';
import { type UpdateSecurityPolicyUseCase } from '@/application/organization/use-cases/update-security-policy.use-case.js';
import { readActor } from '@/presentation/http/middleware/require-permission.middleware.js';
import { type RequestValidator } from '@/presentation/http/middleware/validate.middleware.js';
import { clientOf } from '@/presentation/http/session-client.util.js';
import {
  type mfaCoverageQuerySchema,
  type updateSecurityPolicyBodySchema,
} from '@/presentation/http/validators/security-policy.validator.js';

export interface SecurityPolicyControllerDependencies {
  readonly readPolicy: ReadSecurityPolicyQuery;
  readonly updatePolicy: UpdateSecurityPolicyUseCase;
  readonly coverageReport: MfaCoverageReportQuery;
  readonly updateValidator: RequestValidator<{ body: typeof updateSecurityPolicyBodySchema }>;
  readonly coverageValidator: RequestValidator<{ query: typeof mfaCoverageQuerySchema }>;
}

/**
 * The organization's second-factor policy and the report of who it affects.
 *
 * Wiring only. Which role references are real, whose countdown starts when, and whether the caller
 * is about to lock themselves out are all decided in the use-case, which is the only place that
 * reads the tenant root and the role grants in the same transaction that writes.
 */
export const createSecurityPolicyController = (
  dependencies: SecurityPolicyControllerDependencies,
): {
  readonly read: RequestHandler;
  readonly update: RequestHandler;
  readonly coverage: RequestHandler;
} => ({
  read: async (_request, response) => {
    response.status(200).json(await dependencies.readPolicy.execute(readActor(response)));
  },

  update: async (request, response) => {
    const { body } = dependencies.updateValidator.read(response);

    const result = await dependencies.updatePolicy.execute({
      actor: readActor(response),
      mfaRequiredForRoles: body.mfaRequiredForRoles,
      mfaGracePeriodDays: body.mfaGracePeriodDays,
      ...(body.confirmedSelfLockout === undefined
        ? {}
        : { confirmedSelfLockout: body.confirmedSelfLockout }),
      ipAddress: clientOf(request).ipAddress,
    });

    response.status(200).json(result.policy);
  },

  coverage: async (_request, response) => {
    const { query } = dependencies.coverageValidator.read(response);

    const report = await dependencies.coverageReport.execute({
      actor: readActor(response),
      ...(query.draft === undefined ? {} : { draft: query.draft }),
    });

    response.status(200).json(report);
  },
});
