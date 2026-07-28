import { apiErrorOf } from './problem.errors.js';

/**
 * What `openapi-fetch` returns: never a rejection for a 4xx or a 5xx, always a triple.
 */
export interface ApiResult<TData> {
  readonly data?: TData | undefined;
  readonly error?: unknown;
  readonly response: Response;
}

/**
 * The one place the two conventions meet.
 *
 * `openapi-fetch` hands a failed request back as a value and leaves the decision to the caller;
 * TanStack Query decides everything — retry, error state, the global `MutationCache.onError` — on
 * whether the function it called rejected. Between them, a non-OK response that is merely returned
 * looks like a successful query holding `undefined`, and the screen renders an empty list for a 500.
 *
 * The verdict is the response status rather than the presence of `error`: a body that failed to
 * parse leaves `error` undefined while the request has still failed.
 */
export const unwrapApiResult = <TData>(result: ApiResult<TData>): TData => {
  if (!result.response.ok) throw apiErrorOf(result.error, result.response);

  return result.data as TData;
};
