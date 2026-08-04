import { describe, expect, it } from 'vitest';

import {
  ApiError,
  apiErrorOf,
  errorMessage,
  errorMessageKey,
  isAbortError,
  unwrapApiResult,
} from '@shared/api';

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

    expect(errorMessageKey(error)).toBe('errors.code.task_not_found');
  });

  /**
   * Anything that is not an `ApiError` reached the client without passing the contract — a bug in
   * the browser, an extension, a parse failure. There is no code to translate, and showing the
   * exception text would put a stack sentence in a toast.
   */
  it('falls back to the internal-error key for anything that is not an API error', () => {
    expect(errorMessageKey(new TypeError('undefined is not a function'))).toBe(
      'errors.code.internal_error',
    );
  });
});

/**
 * The one message that carries a value, and the reason it is interpolated rather than glued.
 *
 * «Try again in 30 s» and «Повторите через 30 с» put the number in different places and spell the
 * unit differently; a string assembled from pieces in the source can only be right in the language
 * it was assembled for. The wait itself is not invented here — `Retry-After` is part of the 429
 * response in `docs/api/openapi.yaml`.
 */
describe('a message that carries a value', () => {
  const rateLimited = (headers: Record<string, string>): ApiError =>
    apiErrorOf(
      { code: 'rate_limited', requestId: 'r' },
      new Response(null, { status: 429, headers }),
    );

  it('passes the wait from Retry-After to the sentence', () => {
    expect(errorMessage(rateLimited({ 'retry-after': '30' }))).toEqual({
      key: 'errors.code.rate_limited',
      values: { seconds: 30 },
    });
  });

  it.each([
    ['an HTTP-date, which this server never sends', 'Wed, 21 Oct 2026 07:28:00 GMT'],
    ['a negative delay', '-5'],
    ['rubbish', 'soon'],
  ])('shows the sentence without a wait when the header is %s', (_case, header) => {
    // `Number('soon')` is `NaN`, and a message reading «try again in NaN s» is worse than one that
    // does not say when — so anything that is not a finite, non-negative number counts as absent.
    expect(errorMessage(rateLimited({ 'retry-after': header }))).toEqual({
      key: 'errors.code.rate_limited',
    });
  });

  it('CONTROL: says nothing about a wait for a code that has none', () => {
    const error = new ApiError({ code: 'task_forbidden', status: 403, requestId: 'r', issues: [] });

    expect(errorMessage(error)).toEqual({ key: 'errors.code.task_forbidden' });
  });
});
