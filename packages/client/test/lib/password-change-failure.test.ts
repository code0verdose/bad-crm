import { describe, expect, it } from 'vitest';

import { SharedErrors } from '@bad-crm/shared';

import { SharedApi } from '@shared';

import { AuthLib } from '@units/auth';

/**
 * Where a refused change of password lands on the screen.
 *
 * The screen suite proves that each verdict reaches the right input; this one states the verdicts,
 * including the two nobody can produce from the running product — a `422` naming a field the form
 * does not have, and a failure that is not an `ApiError` at all. Both are the cases where a wrong
 * answer is silent: an error written onto a field nothing renders leaves a form that refuses to
 * submit with nothing on screen to explain why.
 */
const apiError = (
  code: SharedErrors.ErrorCode,
  issues: readonly SharedErrors.ValidationIssue[] = [],
): SharedApi.ApiError => new SharedApi.ApiError({ code, status: 422, requestId: 'req-1', issues });

describe('sorting a refused password change', () => {
  /**
   * The one refusal whose field is knowable without being told: this operation has exactly one
   * credential, and the contract says outright that attaching the message to it is the client's job.
   */
  it('puts a refused credential under the current-password field', () => {
    const failure = AuthLib.passwordChangeFailure(apiError('invalid_credentials'));

    expect(failure.fieldErrors).toEqual({
      currentPassword: 'errors.code.invalid_credentials',
    });
    expect(failure.alertKey).toBeUndefined();
  });

  it('puts a field issue under the field the server named', () => {
    const failure = AuthLib.passwordChangeFailure(
      apiError('validation_failed', [
        { path: 'newPassword', code: 'too_small', message: 'too short' },
      ]),
    );

    expect(failure.fieldErrors).toEqual({ newPassword: 'errors.field.too_small' });
    expect(failure.alertKey).toBeUndefined();
  });

  /**
   * A `path` this form has no input for is dropped, and the refusal is stated above the form instead.
   *
   * Written onto the form it would be an error nothing renders: `@mantine/form` would hold an error
   * for a key with no field, the submit would keep refusing, and the screen would show nothing. The
   * fallback is what keeps the refusal from being silent — which is the actual failure mode, not the
   * unrendered error.
   */
  it('states a field issue it cannot render above the form instead', () => {
    const failure = AuthLib.passwordChangeFailure(
      apiError('validation_failed', [
        { path: 'organizationSlug', code: 'invalid_format', message: 'nope' },
      ]),
    );

    expect(failure.fieldErrors).toEqual({});
    expect(failure.alertKey).toBe('errors.code.validation_failed');
  });

  it('states a refusal that names no field above the form', () => {
    const failure = AuthLib.passwordChangeFailure(apiError('rate_limited'));

    expect(failure.fieldErrors).toEqual({});
    expect(failure.alertKey).toBe('errors.code.rate_limited');
  });

  /**
   * Anything that never passed the contract — a bug in the bundle, a body that failed to parse — has
   * no code to translate, and the generic sentence is the honest answer. The detail is not lost: the
   * error itself goes to the log.
   */
  it('falls back to the generic sentence for something that is not an API error', () => {
    const failure = AuthLib.passwordChangeFailure(new Error('socket hang up'));

    expect(failure.fieldErrors).toEqual({});
    expect(failure.alertKey).toBe('errors.code.internal_error');
  });
});
