import { numberFormatter } from './intl-cache.util.js';

/**
 * `40` → `40%` in English, `40 %` (no-break space) in Russian.
 *
 * Takes a **whole percent** — the unit the contract speaks (`allocationPct`, progress by dates) —
 * and divides by a hundred here, once, rather than at every call site: `Intl` wants a fraction, and
 * a call site that forgets gets `4 000 %`.
 *
 * The sign belongs to the formatter and not to the catalogue: `"{{percent}}%"` is right in English
 * and wrong in Russian, where the sign is set apart from the number (`rules/i18n.mdc` §10). Rounded
 * to a whole percent: the screen has no use for fractions of one.
 */
export const formatPercent = (wholePercent: number, locale: string): string =>
  numberFormatter(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
    wholePercent / 100,
  );
