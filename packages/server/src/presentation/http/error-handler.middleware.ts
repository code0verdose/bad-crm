import { type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type MetricsPort } from '@/application/platform/ports/metrics.port.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import { AccessRefusedError } from '@/domain/access/access.errors.js';
import {
  AppError,
  PayloadTooLargeError,
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
  /**
   * Where a refusal is counted. Absent when this installation switched metrics off — the same shape
   * `HttpServerDependencies.metrics` has, so «off» stays one decision made in the container rather
   * than a `noop` handed to a handler that would then pretend to publish.
   */
  readonly metrics?: MetricsPort | undefined;
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

    // A refusal by the permission layer, counted here — the one place every refusal passes through.
    //
    // Not at the throw site, and the reason is the layer rule rather than convenience: the refusal
    // is built in `domain/access/access.errors.ts`, and `domain` may not do I/O at all
    // (`rules/hexagonal-backend.mdc` §2). Handing it a metrics port to increment would be the same
    // mistake as handing it a clock, and it would put a second thing to remember at every future
    // `assertAllowed`. Here it is structural: a refusal that reached a client passed through this
    // function by construction.
    //
    // **What this does not count, deliberately.** `denyAccess` — the other refusal family, used for
    // «the row is not there, or not yours» — produces a plain `ForbiddenError`/`NotFoundError` and
    // carries no `DenyReason` at all. Guessing one from the status would put an invented value into
    // a label an operator alerts on, and «404 means resource_not_found» is exactly the inference
    // invariant 2 exists to make impossible. Folding that family into the reason-carrying one is
    // STORY-016-02's own work; until then this series counts the refusals that state their reason,
    // and no others.
    if (appError instanceof AccessRefusedError) {
      dependencies.metrics?.incrementPermissionDenied(appError.reason);
    }

    // One place for the header, whatever raised it: the 429 of the rate limiter and the 503 of a
    // saturated dependency both carry `retryAfterSeconds` on `AppError` (STORY-013-06). A second
    // `instanceof` per error with a delay is how one of them ships without the header.
    if (appError?.retryAfterSeconds !== undefined) {
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
