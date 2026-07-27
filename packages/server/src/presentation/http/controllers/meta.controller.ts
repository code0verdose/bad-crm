import { type RequestHandler } from 'express';

import { type DescribeApiUseCase } from '@/application/platform/use-cases/describe-api.use-case.js';
import { serializeApiMeta } from '@/presentation/http/serializers/meta.serializer.js';

export interface MetaControllerDependencies {
  readonly describeApi: DescribeApiUseCase;
}

/**
 * The template every product controller follows: the validator has already run, one use-case is
 * called, its result is serialized.
 *
 * Nothing is parsed here — `validate()` did that and put the result in `res.locals` — and nothing
 * is caught: Express 5 forwards a rejection to the error handler on its own (ADR-0002).
 */
export const createMetaController = (
  dependencies: MetaControllerDependencies,
): { readonly describeApi: RequestHandler } => ({
  describeApi: async (_request, response) => {
    response.json(serializeApiMeta(await dependencies.describeApi.execute()));
  },
});
