import { describe, expect, it } from 'vitest';

import { detectLocale } from '@/app/i18n/detect-locale.util.js';

describe('locale detection follows stored → browser → english', () => {
  it('prefers the stored choice over the browser', () => {
    expect(detectLocale('en', ['ru-RU', 'ru'])).toBe('en');
  });

  it('falls back to the browser when nothing is stored', () => {
    expect(detectLocale(null, ['ru-RU', 'en-GB'])).toBe('ru');
  });

  it('matches the primary subtag, not the whole tag', () => {
    expect(detectLocale(null, ['ru-BY'])).toBe('ru');
  });

  it('skips languages the page does not have', () => {
    expect(detectLocale(null, ['de-DE', 'fr', 'ru'])).toBe('ru');
  });

  it('ignores a stored value that is not a locale', () => {
    expect(detectLocale('klingon', ['de'])).toBe('en');
  });

  it('answers english when nothing matches', () => {
    expect(detectLocale(null, [])).toBe('en');
  });
});
