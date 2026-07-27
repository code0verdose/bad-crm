import { describe, expect, it } from 'vitest';

import { ERROR_CODE_STATUS } from '@bad-crm/shared/errors';

import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitedError,
  ServiceUnavailableError,
  ValidationError,
} from '../../../src/domain/shared/errors/app.errors.js';

/**
 * The status of an application error is never written next to the `throw`.
 *
 * Every subclass derives it from the shared catalog, so "which HTTP status does this mean" has one
 * answer for the server, the client and the OpenAPI document. A hand-written status is how
 * `task_not_found` ends up answered with 403 in one controller and 404 in the next.
 */
describe('AppError derives its status from the shared catalog', () => {
  it.each([
    ['NotFoundError', new NotFoundError('task_not_found'), 'task_not_found', 404],
    ['ForbiddenError', new ForbiddenError('task_forbidden'), 'task_forbidden', 403],
    ['ConflictError', new ConflictError('stale_version'), 'stale_version', 409],
    ['ValidationError', new ValidationError(), 'validation_failed', 422],
    ['PayloadTooLargeError', new PayloadTooLargeError(), 'payload_too_large', 413],
    ['ServiceUnavailableError', new ServiceUnavailableError(), 'service_unavailable', 503],
  ] as const)('%s carries %s → HTTP %i', (_name, error, code, status) => {
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.status).toBe(ERROR_CODE_STATUS[code]);
  });

  it('is an Error, so it survives `throw` and the stack is usable', () => {
    const error = new NotFoundError('project_not_found');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
    expect(error.name).toBe('NotFoundError');
    expect(error.stack).toContain('NotFoundError');
  });

  it('answers an unmatched route without borrowing a resource code', () => {
    const error = new NotFoundError('route_not_found');

    expect(error.status).toBe(404);
    expect(error.code).toBe('route_not_found');
  });

  /**
   * `details` is developer context for the log line — which probe failed, which limit was hit —
   * and the error handler keeps it out of the response body. What the client acts on travels in
   * its own typed property, `ValidationError.issues`, so the two cannot be confused at a call site.
   */
  it('carries optional structured details for the log, not for the response', () => {
    const error = new ServiceUnavailableError({ probe: 'postgres' });

    expect(error.details).toEqual({ probe: 'postgres' });
  });

  it('carries the rejected fields of a validation failure as a typed list', () => {
    const error = new ValidationError([
      { path: 'title', code: 'too_small', message: 'Too small: expected string to have >=1' },
    ]);

    expect(error.issues).toEqual([
      { path: 'title', code: 'too_small', message: 'Too small: expected string to have >=1' },
    ]);
    expect(error.details).toBeUndefined();
  });

  it('states how many fields were rejected in its message, which becomes `detail`', () => {
    expect(new ValidationError([]).message).toBe('0 fields are invalid');
    expect(new ValidationError([{ path: 'a', code: 'custom', message: 'x' }]).message).toBe(
      '1 field is invalid',
    );
    expect(
      new ValidationError([
        { path: 'a', code: 'custom', message: 'x' },
        { path: 'b', code: 'custom', message: 'y' },
      ]).message,
    ).toBe('2 fields are invalid');
  });

  it('carries the back-off a 429 has to advertise', () => {
    const error = new RateLimitedError(30);

    expect(error.code).toBe('rate_limited');
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(30);
  });

  it('keeps the originating failure as `cause`, for the log and not for the response', () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const error = new ServiceUnavailableError({}, cause);

    expect(error.cause).toBe(cause);
    // The message an operator sees in the log is ours; the driver's sentence stays in `cause`,
    // where the error handler cannot accidentally serialize it into a 5xx body.
    expect(error.message).not.toContain('ECONNREFUSED');
  });
});
