import { type RequestHandler } from 'express';

import { type CheckHealthUseCase } from '@/application/platform/use-cases/check-health.use-case.js';
import { type CheckReadinessUseCase } from '@/application/platform/use-cases/check-readiness.use-case.js';
import {
  serializeHealth,
  serializeReadiness,
} from '@/presentation/http/serializers/health.serializer.js';

export interface HealthControllerDependencies {
  readonly checkHealth: CheckHealthUseCase;
  readonly checkReadiness: CheckReadinessUseCase;
}

/**
 * The reference controller: parse nothing (these endpoints take no input), call **one** use-case,
 * serialize its result.
 *
 * What is deliberately absent is as much the point as what is present — no `try/catch` (Express 5
 * forwards a rejection to the error handler by itself, ADR-0002), no `if` about roles, no body
 * assembled inline, no access to a repository. Every later controller is this shape plus a
 * validator call.
 *
 * The only decision made here is the status code, which is transport and belongs to this layer:
 * readiness is a boolean in the domain and 200 or 503 on the wire.
 */
export const createHealthController = (
  dependencies: HealthControllerDependencies,
): { readonly checkHealth: RequestHandler; readonly checkReadiness: RequestHandler } => ({
  checkHealth: async (_request, response) => {
    response.json(serializeHealth(await dependencies.checkHealth.execute()));
  },

  checkReadiness: async (_request, response) => {
    const result = await dependencies.checkReadiness.execute();

    response.status(result.ready ? 200 : 503).json(serializeReadiness(result));
  },
});
