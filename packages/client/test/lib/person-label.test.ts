import { describe, expect, it } from 'vitest';

import { SharedLib } from '@shared';

const { personLabel } = SharedLib;

/**
 * What a person is called anywhere in the product, and what stands in when nobody has named them.
 *
 * One rule for every screen that names somebody — the team roster and its picker, the invitation
 * list, the member table and the org chart, the project card — which until now spelled it in five
 * files. The fallback is the caller's to choose, because the answers differ in what they carry: a
 * directory row has an address, an org-chart node has only an id.
 */
describe('personLabel', () => {
  it('is the full name, first then last', () => {
    expect(personLabel({ firstName: 'Anna', lastName: 'Ivanova' }, 'anna@example.test')).toBe(
      'Anna Ivanova',
    );
  });

  it.each([
    ['only a first name', 'Anna', '', 'Anna'],
    ['only a last name', '', 'Ivanova', 'Ivanova'],
  ])('is %s without a stray space', (_case, firstName, lastName, expected) => {
    expect(personLabel({ firstName, lastName }, 'fallback')).toBe(expected);
  });

  it.each([
    ['empty', '', ''],
    ['whitespace only', ' ', '  '],
  ])('is the fallback when the name is %s — never a blank', (_case, firstName, lastName) => {
    expect(personLabel({ firstName, lastName }, 'x@example.test')).toBe('x@example.test');
  });
});
