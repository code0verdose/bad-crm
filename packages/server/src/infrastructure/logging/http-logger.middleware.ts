import { type RequestHandler } from 'express';
import { type Logger } from 'pino';
import { pinoHttp } from 'pino-http';

import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import { routeTemplateOf } from '@/infrastructure/logging/route-template.util.js';

export interface HttpLoggerDependencies {
  readonly logger: Logger;
  readonly requestContext: RequestContextPort;
}

/**
 * The completion line of every request: `requestId`, `route`, `statusCode`, `durationMs`,
 * `organizationId`, `userId` (rules/observability.mdc, rule 2).
 *
 * It lives in `infrastructure/logging` rather than in `presentation/http` because it is the logging
 * adapter's binding to the transport: `presentation` may not import infrastructure, and the
 * composition root passes the finished middleware in. The tenant and user fields arrive through the
 * `AsyncLocalStorage` mixin of the root logger, so authentication (EPIC-006) fills them in without
 * touching this file.
 *
 * **Neither request bodies nor URLs are logged.** The default pino-http serializers write `req.url`
 * and the full header set; the URL of a protected link *is* the credential, and a request body is
 * user content. Only the method survives, plus the route template — which is a pattern and carries
 * no identifiers.
 */
export const createHttpLogger = (dependencies: HttpLoggerDependencies): RequestHandler =>
  pinoHttp({
    logger: dependencies.logger,
    // Reuses the identifier the context middleware already established, so the completion line and
    // every line inside the request carry the same value rather than two competing ones.
    genReqId: () => dependencies.requestContext.current()?.requestId ?? '',
    customAttributeKeys: { reqId: 'requestId', responseTime: 'durationMs' },
    customLogLevel: (_request, response, error) => {
      if (error !== undefined || response.statusCode >= 500) return 'error';

      return response.statusCode >= 400 ? 'warn' : 'info';
    },
    // `customSuccessObject`/`customErrorObject`, **not** `customProps`: pino-http evaluates
    // `customProps` when the request starts *and* when it completes, and merges both results into
    // one line. Measured against a running process: the finished line carried
    // `"route":"unmatched","statusCode":200` followed by `"route":"/ready","statusCode":200` —
    // duplicate JSON keys whose first copy is the state before routing. A parser keeping the first
    // occurrence (and a `grep -o` doing the same) then reads a status that was never returned.
    customSuccessObject: (request, response, value: object) => ({
      ...value,
      route: routeTemplateOf(request),
      statusCode: response.statusCode,
    }),
    customErrorObject: (request, response, _error, value: object) => ({
      ...value,
      route: routeTemplateOf(request),
      statusCode: response.statusCode,
    }),
    customSuccessMessage: () => 'request completed',
    customErrorMessage: () => 'request failed',
    serializers: {
      req: (request: { method?: string }) => ({ method: request.method }),
      res: (response: { statusCode?: number }) => ({ statusCode: response.statusCode }),
    },
  });
