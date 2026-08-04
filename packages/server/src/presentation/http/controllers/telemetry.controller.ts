import { type RequestHandler } from 'express';

import { type RecordClientErrorUseCase } from '@/application/platform/use-cases/record-client-error.use-case.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import { type ClientErrorBody } from '@/presentation/http/validators/telemetry.validator.js';

export interface TelemetryControllerDependencies {
  readonly recordClientError: RecordClientErrorUseCase;
  readonly requestContext: RequestContextPort;
}

/**
 * One use-case, one status, no body.
 *
 * The reporter is taken from the request rather than from the payload: a body that named its own
 * user would let anybody spend somebody else's budget — and, worse, attribute a failure to them.
 */
export const createTelemetryController = (
  dependencies: TelemetryControllerDependencies,
): { readonly reportClientError: RequestHandler } => ({
  reportClientError: async (request, response) => {
    const body = request.body as ClientErrorBody;

    await dependencies.recordClientError.execute(
      {
        message: body.message,
        stack: body.stack,
        appVersion: body.appVersion,
        route: body.route,
        reference: body.reference,
        requestId: body.requestId,
      },
      {
        userId: dependencies.requestContext.current()?.userId ?? undefined,
        ipAddress: request.ip,
      },
    );

    response.status(204).end();
  },
});
