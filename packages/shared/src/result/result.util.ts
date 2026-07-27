import type { Result } from './result.types.js';

export const ok = <TValue>(value: TValue): Result<TValue, never> => ({ ok: true, value });

export const err = <TError>(error: TError): Result<never, TError> => ({ ok: false, error });

export const isOk = <TValue, TError>(
  result: Result<TValue, TError>,
): result is { ok: true; value: TValue } => result.ok;

export const isErr = <TValue, TError>(
  result: Result<TValue, TError>,
): result is { ok: false; error: TError } => !result.ok;

/** Maps the success branch and passes the failure through untouched. */
export const mapResult = <TValue, TError, TNext>(
  result: Result<TValue, TError>,
  map: (value: TValue) => TNext,
): Result<TNext, TError> => (result.ok ? ok(map(result.value)) : result);

/** Collapses a result to a value, using the fallback on the failure branch. */
export const unwrapOr = <TValue, TError>(
  result: Result<TValue, TError>,
  fallback: TValue,
): TValue => (result.ok ? result.value : fallback);
