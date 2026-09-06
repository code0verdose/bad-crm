import { describe, expect, it } from 'vitest';

import { organizationSettingsSearchSchema } from './organization-settings-search.schema.js';

/**
 * The address bar is the screen's state, and a hand-edited one must not be able to reach a
 * component. Every field falls back rather than failing: `validateSearch` throwing would replace
 * the screen with an error boundary over a mistyped query string — and, because every write here is
 * `replace`, that address would stay in the bar and a reload would not clear it.
 */
describe('organizationSettingsSearchSchema', () => {
  it('opens on the security tab when nothing is in the address', () => {
    expect(organizationSettingsSearchSchema.parse({})).toEqual({
      tab: 'security',
      q: '',
      role: [],
      gate: [],
    });
  });

  it.each([
    ['a tab that does not exist', { tab: 'billing' }, { tab: 'security' }],
    ['a phrase longer than the field allows', { q: 'x'.repeat(200) }, { q: '' }],
    ['a verdict that is not one', { gate: ['sideways'] }, { gate: [] }],
    ['a role list longer than a policy may name', { role: Array(65).fill('admin') }, { role: [] }],
    ['a filter that is not a list at all', { gate: 'grace' }, { gate: [] }],
    ['a role reference longer than any role name', { role: ['x'.repeat(80)] }, { role: [] }],
    ['a phrase that is not text', { q: 7 }, { q: '' }],
    ['a tab that is not text', { tab: null }, { tab: 'security' }],
  ])('falls back on %s', (_case, input, expected) => {
    expect(organizationSettingsSearchSchema.parse(input)).toMatchObject(expected);
  });

  it('keeps what it recognises', () => {
    expect(
      organizationSettingsSearchSchema.parse({
        tab: 'security',
        q: ' boris ',
        role: ['admin'],
        gate: ['grace', 'enrollment_required'],
      }),
    ).toEqual({
      tab: 'security',
      // Trimmed by the schema, so the filter and the URL agree about what was searched for.
      q: 'boris',
      role: ['admin'],
      gate: ['grace', 'enrollment_required'],
    });
  });
});
