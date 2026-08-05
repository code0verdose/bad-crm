import { type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import { AccessRefusedError } from '@/domain/access/access.errors.js';
import {
  AppError,
  PayloadTooLargeError,
  RateLimitedError,
  ValidationError,
} from '@/domain/shared/errors/app.errors.js';
import {
  PROBLEM_CONTENT_TYPE,
  serializeProblem,
} from '@/presentation/http/serializers/problem.serializer.js';
import { toValidationIssues } from '@/presentation/http/validators/zod-issues.util.js';

export interface ErrorHandlerDependencies {
  readonly logger: LoggerPort;
  readonly requestContext: RequestContextPort;
}

/** Errors the body parser raises before any of our code runs. */
interface BodyParserError extends Error {
  readonly type?: string;
}

const isBodyParserError = (error: unknown): error is BodyParserError =>
  error instanceof Error && typeof (error as BodyParserError).type === 'string';

/**
 * Everything the application throws on purpose, expressed as an `AppError`.
 *
 * `undefined` means "not one of ours", and that distinction is the whole safety property of the
 * handler: an unexpected exception is answered 500 with no detail, so a schema name or a driver
 * message never reaches the client.
 */
const asAppError = (error: unknown): AppError | undefined => {
  if (error instanceof AppError) return error;

  // A schema parsed outside the `validate` middleware — a webhook payload, a job body, an external
  // response. The per-field list is built the same way, so the response is identical wherever the
  // schema ran.
  if (error instanceof ZodError) {
    return new ValidationError(toValidationIssues(error), error);
  }

  if (isBodyParserError(error)) {
    if (error.type === 'entity.too.large') return new PayloadTooLargeError({ limit: '1mb' }, error);
    if (error.type === 'entity.parse.failed') {
      // The body never became a value, so there is no field to point at: the empty path is the
      // documented way of saying "the payload as a whole".
      return new ValidationError(
        [{ path: '', code: 'invalid_type', message: 'Request body is not valid JSON' }],
        error,
      );
    }
  }

  return undefined;
};

/**
 * The single exit for every failure of the HTTP surface (stack.md, «Формат ошибок»).
 *
 * Controllers throw and do not catch — in Express 5 a rejected promise arrives here on its own — so
 * this is the only place that decides a status code, a body and a log level. Consequences worth
 * naming:
 *
 * - **The status comes from the error's `code`, never from the handler.** In particular the handler
 *   never turns a 404 into a 403: the choice between them is made once, in
 *   `domain/shared/errors/access-denial.util.ts`, because a denial that crosses organizations must
 *   be indistinguishable from a resource that does not exist (invariant 2 of CLAUDE.md).
 * - **Expected failures log at `warn` without a stack, unexpected ones at `error` with it.** A 404
 *   logged at `error` with a stack trace is how a team learns to ignore the level that should page
 *   somebody.
 * - **A response that already started is left alone.** Express's default handler destroys the
 *   connection; writing a second set of headers would throw inside the error handler itself, and
 *   the process would lose the original error as well.
 */
export const createErrorHandler = (dependencies: ErrorHandlerDependencies): ErrorRequestHandler => {
  return (error: unknown, _request, response, next) => {
    if (response.headersSent) {
      next(error);

      return;
    }

    const requestId = dependencies.requestContext.current()?.requestId ?? '';
    const appError = asAppError(error);
    const status = appError?.status ?? 500;
    const code = appError?.code ?? 'internal_error';

    if (appError !== undefined && status < 500) {
      // `details` goes to the log and never to the body: it is developer context (which probe,
      // which limit), and the response carries only what the client can act on.
      dependencies.logger.warn(
        { requestId, code, status, details: appError.details },
        'request rejected',
      );
    } else {
      dependencies.logger.error({ requestId, code, status, err: error }, 'unhandled error');
    }

    if (appError instanceof RateLimitedError) {
      response.setHeader('Retry-After', String(appError.retryAfterSeconds));
    }

    response
      .status(status)
      .type(PROBLEM_CONTENT_TYPE)
      .json(
        serializeProblem({
          code,
          status,
          detail: appError?.message,
          requestId,
          reason: appError instanceof AccessRefusedError ? appError.reason : undefined,
          errors: appError instanceof ValidationError ? appError.issues : undefined,
        }),
      );
  };
};
