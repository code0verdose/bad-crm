import { type RequestHandler } from 'express';

import { type IdGeneratorPort } from '@/application/platform/ports/id-generator.port.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Identifiers a reverse proxy may hand us. Anything else is replaced rather than trusted: the value
 * is echoed back in a response header and written into every log line of the request, so an
 * unchecked one is both a header-injection vector and a way to poison log search with megabytes of
 * junk under a single key.
 */
const SAFE_REQUEST_ID = /^[\w-]{1,64}$/;

export interface RequestContextMiddlewareDependencies {
  readonly requestContext: RequestContextPort;
  /**
   * `next()` only. A request id is a correlation identifier, not an entity key, so this middleware
   * has no business with `uuid()` — and asking for the whole port would make every stub of it
   * implement a method this file never calls (rules/hexagonal-backend.mdc, rule 6).
   */
  readonly idGenerator: Pick<IdGeneratorPort, 'next'>;
}

/**
 * Establishes the ambient context of one request: `requestId` now, `organizationId` and `userId`
 * once authentication lands (EPIC-006).
 *
 * Mounted first, because everything after it — the completion line of `pino-http`, every log line
 * inside a use-case, the `requestId` of the problem document — reads what it stores. An id supplied
 * by the proxy is kept so that one identifier spans the whole chain from Caddy to the database
 * query, which is the entire point of the header.
 */
export const createRequestContextMiddleware = (
  dependencies: RequestContextMiddlewareDependencies,
): RequestHandler => {
  return (request, response, next) => {
    const incoming = request.header(REQUEST_ID_HEADER);
    const requestId =
      incoming !== undefined && SAFE_REQUEST_ID.test(incoming)
        ? incoming
        : dependencies.idGenerator.next();

    response.setHeader(REQUEST_ID_HEADER, requestId);

    dependencies.requestContext.run({ requestId, organizationId: null, userId: null }, next);
  };
};
