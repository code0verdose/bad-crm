import { describe, expect, it } from 'vitest';

import { apiErrorOf, ApiError, isApiError } from '@shared/api';

/**
 * `application/problem+json` (RFC 9457) is the only error shape this API produces, and `code` is
 * the only part of it a user ever sees the consequence of: the client picks an i18n key by `code`
 * and never shows `title` or `detail` (`rules/api-contract.mdc` §5, `rules/errors-and-toasts.mdc`
 * §10). These assertions are about that translation — from a body on the wire to a typed error the
 * UI can act on without parsing English.
 */
const problemResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

const validationProblem = {
  type: 'https://bad-crm.dev/problems/validation-failed',
  title: 'Validation failed',
  status: 422,
  code: 'validation_failed',
  detail: '1 field is invalid',
  requestId: '01J8Z2F5Q3K9V6N0R4T7YB3XQD',
  errors: [
    { path: 'title', code: 'too_small', message: 'String must contain at least 1 character' },
  ],
};

describe('a problem document becomes a typed error', () => {
  it('carries the machine-readable code, the status and the request id', () => {
    const error = apiErrorOf(validationProblem, problemResponse(422, validationProblem));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('validation_failed');
    expect(error.status).toBe(422);
    expect(error.requestId).toBe('01J8Z2F5Q3K9V6N0R4T7YB3XQD');
  });

  it('keeps the per-field issues, so a form can highlight the input that was rejected', () => {
    const error = apiErrorOf(validationProblem, problemResponse(422, validationProblem));

    expect(error.issues).toEqual([
      { path: 'title', code: 'too_small', message: 'String must contain at least 1 character' },
    ]);
  });

  it('reports no issues when the problem carries none', () => {
    const problem = {
      ...validationProblem,
      code: 'task_not_found',
      status: 404,
      errors: undefined,
    };

    expect(apiErrorOf(problem, problemResponse(404, problem)).issues).toEqual([]);
  });

  /**
   * The message is for a log line and a failing test, never for a user — so it names the code and
   * the status rather than repeating `detail`, which the rule forbids showing.
   */
  it('does not put the server detail in the message a developer reads', () => {
    const error = apiErrorOf(validationProblem, problemResponse(422, validationProblem));

    expect(error.message).toContain('validation_failed');
    expect(error.message).not.toContain('1 field is invalid');
  });
});

describe('a body that is not a problem document', () => {
  it.each([
    ['no body at all', undefined],
    ['a string', 'Internal Server Error'],
    ['null', null],
    ['an object without a code', { title: 'nope', requestId: 'r-1' }],
    ['an object whose code is not in the catalog', { code: 'kaboom', requestId: 'r-1' }],
    ['an object whose requestId is missing', { code: 'internal_error' }],
  ])('is reported as an internal error rather than trusted — %s', (_case, body) => {
    const error = apiErrorOf(body, problemResponse(500, body ?? null));

    expect(error.code).toBe('internal_error');
  });

  /**
   * The status still comes from the response. A gateway that answers 502 with HTML is not the API
   * violating its contract in a way the client can name, but it is still a 502 — and the retry
   * policy of the query client decides on the status, not on the code.
   */
  it('takes the status from the response', () => {
    expect(apiErrorOf('<html>502</html>', problemResponse(502, null)).status).toBe(502);
  });

  it('falls back to the x-request-id header when the body has no request id', () => {
    const response = new Response('nope', { status: 500, headers: { 'x-request-id': 'hdr-1' } });

    expect(apiErrorOf('nope', response).requestId).toBe('hdr-1');
  });

  it('reports an empty request id when neither the body nor the headers carry one', () => {
    expect(apiErrorOf('nope', new Response('nope', { status: 500 })).requestId).toBe('');
  });
});

describe('recognising the error at a call site', () => {
  it('narrows an ApiError', () => {
    expect(isApiError(apiErrorOf(validationProblem, problemResponse(422, validationProblem)))).toBe(
      true,
    );
  });

  it.each([
    ['a plain Error', new Error('boom')],
    ['a string', 'boom'],
  ])('does not narrow %s', (_case, value) => {
    expect(isApiError(value)).toBe(false);
  });
});
