/**
 * A cancelled request is not a failure, and every layer that reacts to errors has to know it.
 *
 * TanStack Query aborts the previous request whenever a query key changes — a new filter, a new
 * page, an unmounted screen — and each of those rejects with an `AbortError`. Treated as a failure
 * it becomes a retry, a red toast and a logged incident for a user who simply typed another letter
 * into a search box (`rules/errors-and-toasts.mdc` §11, `rules/tanstack-query.mdc` §4).
 *
 * The check is on `name`, not on the class: `AbortSignal.reason` is a `DOMException` in the browser
 * and in Node, while a library that models its own cancellation uses a plain `Error` with the same
 * name. Both are the same event as far as this application is concerned.
 */
export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';
