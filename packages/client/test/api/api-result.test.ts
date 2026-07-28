import { describe, expect, it } from 'vitest';

import { ApiError, errorMessageKey, isAbortError, unwrapApiResult } from '@shared/api';

/**
 * `openapi-fetch` never throws on a 4xx or a 5xx: it returns `{ error, response }` and leaves the
 * decision to the caller. TanStack Query, on the other hand, decides everything — retry, error
 * state, the global `MutationCache.onError` — on whether the function it called rejected. This is
 * the one place the two conventions meet, so it is the one place a non-OK response turns into a
 * thrown `ApiError`.
 */
const okResult = <T>(data: T, status = 200) => ({
  data,
  response: new Response(JSON.stringify(data), { status }),
});

describe('unwrapping a typed API result', () => {
  it('returns the payload of a successful response', () => {
    expect(unwrapApiResult(okResult({ apiVersion: 'v1' }))).toEqual({ apiVersion: 'v1' });
  });

  it('returns undefined for a 204, which carries no payload by definition', () => {
    expect(
      unwrapApiResult({ data: undefined, response: new Response(null, { status: 204 }) }),
    ).toBeUndefined();
  });

  it('throws a typed error when the server answered with a problem document', () => {
    const problem = {
      type: 'https://bad-crm.dev/problems/task-not-found',
      title: 'Task not found',
      status: 404,
      code: 'task_not_found',
      requestId: 'req-1',
    };

    expect(() =>
      unwrapApiResult({ error: problem, response: new Response(null, { status: 404 }) }),
    ).toThrow(ApiError);
  });

  /**
   * A non-OK response with no parsable body is still a failure. Reading only `error` would return
   * `undefined` as if it were data, and the screen would render an empty list for a 500.
   */
  it('throws when the response is not ok even without a parsable body', () => {
    expect(() =>
      unwrapApiResult({ data: undefined, response: new Response(null, { status: 500 }) }),
    ).toThrow(ApiError);
  });
});

describe('recognising a cancelled request', () => {
  it('recognises the DOMException an AbortController produces', () => {
    const controller = new AbortController();
    controller.abort();

    expect(isAbortError(controller.signal.reason)).toBe(true);
  });

  it.each([
    ['a different Error', new Error('network down')],
    ['a string', 'AbortError'],
    ['null', null],
  ])('does not mistake %s for a cancellation', (_case, value) => {
    expect(isAbortError(value)).toBe(false);
  });
});

describe('choosing the message a user sees', () => {
  it('selects the i18n key by the stable code, never by the server text', () => {
    const error = new ApiError({ code: 'task_not_found', status: 404, requestId: 'r', issues: [] });

    expect(errorMessageKey(error)).toBe('errors.task_not_found');
  });

  /**
   * Anything that is not an `ApiError` reached the client without passing the contract — a bug in
   * the browser, an extension, a parse failure. There is no code to translate, and showing the
   * exception text would put a stack sentence in a toast.
   */
  it('falls back to the internal-error key for anything that is not an API error', () => {
    expect(errorMessageKey(new TypeError('undefined is not a function'))).toBe(
      'errors.internal_error',
    );
  });
});
