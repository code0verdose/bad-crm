/**
 * Explicit success/failure value.
 *
 * Used where a failure is an expected outcome rather than an exception — a parse that may fail, a
 * policy decision, a conversion. Exceptions stay for genuinely exceptional situations, so the two
 * are not interchangeable: a `Result` that is never inspected is a compile-time error at the call
 * site, a swallowed exception is not.
 */
export type Result<TValue, TError> =
  { readonly ok: true; readonly value: TValue } | { readonly ok: false; readonly error: TError };
