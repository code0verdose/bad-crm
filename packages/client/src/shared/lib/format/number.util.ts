import { numberFormatter } from './intl-cache.util.js';

/**
 * `1234567` → `1 234 567` in Russian, `1,234,567` in English.
 *
 * The separator is the whole point: inserting spaces by hand produces a number that reads as
 * three numbers in the language that uses a space as a decimal mark, and a thousands separator is
 * exactly the kind of thing nobody notices until it is in a financial report.
 */
export const formatNumber = (value: number, locale: string): string =>
  numberFormatter(locale, {}).format(value);
