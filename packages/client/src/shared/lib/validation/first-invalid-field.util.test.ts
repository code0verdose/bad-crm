import { describe, expect, it } from 'vitest';

import { firstInvalidField } from './first-invalid-field.util.js';

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

  /**
   * A server lists its issues in the order it found them, which is not the order of the screen: a
   * refusal naming the lead and then the name must still put the caret on the name, the field above.
   */
  it('follows the screen order when one is given, not the order of the record', () => {
    expect(
      firstInvalidField({ leadId: 'x', name: 'y' }, ['key', 'name', 'description', 'leadId']),
    ).toBe('name');
  });

  it('ignores a field the screen order does not have, rather than guessing where it is', () => {
    expect(firstInvalidField({ status: 'x' }, ['key', 'name'])).toBe('');
  });

  it('skips a field whose message is absent', () => {
    expect(firstInvalidField({ key: undefined, name: 'y' }, ['key', 'name'])).toBe('name');
  });
});
