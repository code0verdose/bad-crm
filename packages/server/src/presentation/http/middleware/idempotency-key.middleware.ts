import { type RequestHandler } from 'express';

import { ValidationError } from '@/domain/shared/errors/app.errors.js';

/** The bounds `components.parameters.IdempotencyKey` declares. */
const MIN_LENGTH = 16;
const MAX_LENGTH = 128;

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * Refuses a request that omits `Idempotency-Key` where the contract declares it mandatory.
 *
 * **This is the half of idempotency that can be enforced without a store, and it is the half that
 * matters first.** Replaying a stored response needs a table keyed by `(key, request hash)`, which
 * is a cross-cutting mechanism rather than part of this epic; until it exists, a retry of
 * `POST /auth/register` still cannot create a second organization, because `organizations.slug` is
 * globally unique and the second insert is refused with `409 organization_already_exists`. What is
 * missing is the *convenience* — the retry gets a 409 instead of the original 201 — and not the
 * safety. The open half is recorded in STORY-006-01.
 *
 * Requiring the header now rather than "when the store lands" is deliberate: a client that never
 * learned to send it is a client that cannot be made idempotent later without a breaking change.
 */
export const requireIdempotencyKey = (): RequestHandler => {
  return (request, _response, next) => {
    const key = request.headers[IDEMPOTENCY_KEY_HEADER];
    const value = typeof key === 'string' ? key.trim() : '';

    if (value.length < MIN_LENGTH || value.length > MAX_LENGTH) {
      next(
        new ValidationError([
          {
            path: 'Idempotency-Key',
            code: value === '' ? 'invalid_type' : 'invalid_value',
            message: `Idempotency-Key must be between ${MIN_LENGTH} and ${MAX_LENGTH} characters`,
          },
        ]),
      );

      return;
    }

    next();
  };
};
