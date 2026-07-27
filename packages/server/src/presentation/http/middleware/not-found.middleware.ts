import { type RequestHandler } from 'express';

import { NotFoundError } from '@/domain/shared/errors/app.errors.js';

/**
 * Turns "no route matched" into the same problem document as every other failure.
 *
 * Without it Express answers with its own HTML page, which means one endpoint of the API speaks a
 * different language than the rest — and a client that parses `code` gets a parse error instead of
 * a 404 it can act on.
 */
export const createNotFoundMiddleware = (): RequestHandler => (_request, _response, next) => {
  next(new NotFoundError('route_not_found'));
};
