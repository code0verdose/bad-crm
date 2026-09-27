import { describe, expect, it } from 'vitest';

import { projectColorOptions } from './project-color-options.util.js';

describe('projectColorOptions', () => {
  it('offers the measured palette, each with a written-out label key', () => {
    expect(projectColorOptions().map((option) => option.value)).toEqual([
      'brand',
      'info',
      'success',
      'warning',
      'danger',
      'neutral',
    ]);
    expect(projectColorOptions()[0]).toEqual({ value: 'brand', labelKey: 'projects.color.brand' });
  });

  it('does not repeat a stored colour that is in the palette', () => {
    expect(projectColorOptions('info')).toHaveLength(6);
  });

  it('keeps a stored colour outside the palette selectable, named as it is', () => {
    const options = projectColorOptions('legacy-hue');

    expect(options).toHaveLength(7);
    expect(options.at(-1)).toEqual({
      value: 'legacy-hue',
      labelKey: 'projects.color.other',
      values: { name: 'legacy-hue' },
    });
  });
});
