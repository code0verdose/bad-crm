import { errorCodeStatus, type ErrorCode, type ErrorResource } from '@bad-crm/shared/errors';

/** Structured extras carried into the `application/problem+json` document, never into a 5xx body. */
export type ErrorDetails = Readonly<Record<string, unknown>>;

/**
 * Base of every failure the application raises on purpose.
 *
 * Two properties make it the only kind of error the HTTP layer has to understand:
 *
 * 1. **`code` comes from the closed catalog in `packages/shared`.** A typo is a compile error, and
 *    the client can map the code to an i18n key without the server ever sending prose
 *    (stack.md, «Формат ошибок»).
 * 2. **`status` is derived from `code`, never passed in.** The mapping code → HTTP lives in one
 *    table shared by the server, the client and (from STORY-003-05) the OpenAPI document, so the
 *    same code cannot be answered 403 in one controller and 404 in the next.
 *
 * Anything that is *not* an `AppError` reaching `error-handler.middleware.ts` is by definition
 * unexpected and is answered `500 internal_error` with no detail.
 */
export abstract class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetails;

  protected constructor(code: ErrorCode, message: string, details?: ErrorDetails, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });

    this.code = code;
    this.status = errorCodeStatus(code);
    this.name = new.target.name;
    if (details !== undefined) this.details = details;
  }
}

/**
 * The resource does not exist — or exists in another organization, which is the same answer.
 *
 * `route_not_found` is included because an unmatched path is not about a resource at all; see the
 * catalog comment in `packages/shared/src/errors/error-code.enums.ts`.
 */
export class NotFoundError extends AppError {
  constructor(code: `${ErrorResource}_not_found` | 'route_not_found', details?: ErrorDetails) {
    super(code, `Resource not found: ${code}`, details);
  }
}

/**
 * The caller may see the resource but not perform this action **inside their own organization**.
 *
 * A denial that crosses organizations is a `NotFoundError`; the choice is made once, in
 * `access-denial.util.ts`, and not at the throw site.
 */
export class ForbiddenError extends AppError {
  constructor(code: `${ErrorResource}_forbidden`, details?: ErrorDetails) {
    super(code, `Access denied: ${code}`, details);
  }
}

/** The request collides with the current state: duplicate key, stale version, replayed key. */
export class ConflictError extends AppError {
  constructor(
    code: `${ErrorResource}_already_exists` | 'stale_version' | 'idempotency_key_reuse',
    details?: ErrorDetails,
  ) {
    super(code, `Conflicting request: ${code}`, details);
  }
}

/** Input rejected at the boundary. The per-field list is filled in by STORY-003-04. */
export class ValidationError extends AppError {
  constructor(details?: ErrorDetails, cause?: unknown) {
    super('validation_failed', 'Request validation failed', details, cause);
  }
}

/** The body exceeded the 1 MB limit; files never travel through the API (ADR-0015). */
export class PayloadTooLargeError extends AppError {
  constructor(details?: ErrorDetails, cause?: unknown) {
    super('payload_too_large', 'Request body is too large', details, cause);
  }
}

/**
 * A dependency needed to answer is unavailable.
 *
 * The driver exception is kept as `cause` — it belongs in the log, where the error serializer can
 * strip its headers, and never in a response body: connection errors quote connection strings, and
 * connection strings quote passwords.
 */
export class ServiceUnavailableError extends AppError {
  constructor(details?: ErrorDetails, cause?: unknown) {
    super('service_unavailable', 'A dependency is unavailable', details, cause);
  }
}
