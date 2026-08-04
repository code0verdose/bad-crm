import { dateFormatter } from './intl-cache.util.js';

/** `2026-07-26T10:00:00Z` → `26 июл. 2026 г.` / `Jul 26, 2026`, in the reader's zone. */
export const formatDate = (iso: string, locale: string, timeZone: string): string =>
  dateFormatter(locale, { dateStyle: 'medium', timeZone }).format(new Date(iso));

export const formatDateTime = (iso: string, locale: string, timeZone: string): string =>
  dateFormatter(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
    new Date(iso),
  );

/**
 * The same moment with its zone spelled out, for anything two people in different places have to
 * agree on — a call, a deadline (`rules/i18n.mdc` §11).
 *
 * `timeZoneName: 'short'` rather than the IANA name: `GMT+3` is what somebody compares against
 * their own clock, `Europe/Moscow` is what a database stores.
 */
export const formatDateTimeWithZone = (iso: string, locale: string, timeZone: string): string =>
  dateFormatter(locale, {
    // Spelled out field by field rather than with `dateStyle`/`timeStyle`, and not for taste:
    // combining either style with `timeZoneName` throws `TypeError: Invalid option` — the styles are
    // complete patterns and refuse to be extended. Measured, not assumed; the first version of this
    // function used the styles and threw on its first call.
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(iso));
