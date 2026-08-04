import { LOCALES, type Locale } from './locale.types.js';

/** Where the choice survives a reload. Read by the inline bootstrap in `index.html` too. */
export const LOCALE_STORAGE_KEY = 'bcl-locale';

const isLocale = (value: string | null): value is Locale =>
  value !== null && LOCALES.includes(value as Locale);

/**
 * Stored choice → browser preference → English.
 *
 * A pure function of its two inputs so that the order can be asserted without a DOM: the failure
 * this prevents is the one where a Russian-speaking visitor who has already switched to English
 * gets Russian again on the next visit, because the browser was consulted first.
 *
 * `navigator.languages` entries are tags (`ru-RU`, `en-GB`), so only the primary subtag is
 * compared — matching the whole tag would fall through to English for most real browsers.
 */
export const detectLocale = (stored: string | null, preferred: readonly string[]): Locale => {
  if (isLocale(stored)) return stored;

  for (const tag of preferred) {
    const primary = tag.toLowerCase().split('-')[0] ?? '';
    if (isLocale(primary)) return primary;
  }

  return 'en';
};
