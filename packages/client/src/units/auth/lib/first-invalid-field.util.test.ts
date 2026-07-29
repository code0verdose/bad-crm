import { describe, expect, it } from 'vitest';

import { firstInvalidField } from '@units/auth/lib';

describe('the field a failed submit focuses', () => {
  it('is the first one the schema complained about', () => {
    expect(firstInvalidField({ email: 'validation.email.invalid' })).toBe('email');
  });

  it('is the first in declaration order when several are wrong', () => {
    expect(
      firstInvalidField({
        email: 'validation.email.invalid',
        password: 'validation.password.required',
      }),
    ).toBe('email');
  });

  /**
   * «Failed, but nothing is wrong» should not steal the caret to a guessed field: an empty path
   * matches no input, so the focus stays where the user put it.
   */
  it('is nothing at all when there is nothing to fix', () => {
    expect(firstInvalidField({})).toBe('');
  });
});
