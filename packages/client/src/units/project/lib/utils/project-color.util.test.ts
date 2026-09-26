import { describe, expect, it } from 'vitest';

import { projectColorValue } from './project-color.util.js';

describe('projectColorValue', () => {
  it('turns a palette name into the theme variable, not a literal', () => {
    expect(projectColorValue('brand')).toBe('var(--mantine-color-brand-filled)');
  });

  it.each([
    { name: 'a hex literal', value: '#ff0000' },
    { name: 'an attempt to close the value', value: 'red);background:url(x' },
    { name: 'an empty string', value: '' },
    { name: 'upper case', value: 'Brand' },
  ])('paints nothing for $name', ({ value }) => {
    expect(projectColorValue(value)).toBeUndefined();
  });
});
