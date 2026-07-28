import { isApiError } from './problem.errors.js';

/** Namespace of the error catalogue in `errors.json`, in both languages (`rules/i18n.mdc`). */
export const ERROR_MESSAGE_KEY_PREFIX = 'errors';

/**
 * Maps a failure to the i18n key that describes it, and never to text.
 *
 * Anything that is not an `ApiError` reached this point without passing the contract — a bug in the
 * bundle, a browser extension, a body that failed to parse. There is no stable code to translate,
 * and rendering the exception message would put a stack sentence in front of a user, so the generic
 * key is the answer. The detail is not lost: the error itself goes to the log.
 */
export const errorMessageKey = (error: unknown): string =>
  `${ERROR_MESSAGE_KEY_PREFIX}.${isApiError(error) ? error.code : 'internal_error'}`;
