/**
 * The two languages this product ships, as far as an outgoing message is concerned.
 *
 * EN and RU are equal (ADR-0019, `rules/i18n.mdc`), and mail is the one surface where the server
 * rather than the client picks between them: there is no browser to read `Accept-Language` from and
 * no bundle to load a catalog into. The choice is therefore made from `users.locale`, which is what
 * the person set.
 */
export type MailLocale = 'en' | 'ru';

/**
 * `ru`, `ru-RU`, `RU_ru` → `ru`; everything else → `en`.
 *
 * English is the fallback rather than an error because the column is a free-form tag: an account
 * created through a future import with `de-DE` must still receive its mail, and a message in a
 * language the reader may not have is strictly better than no message at all — this is the letter
 * that tells somebody their password was changed.
 */
export const mailLocaleOf = (locale: string): MailLocale =>
  locale.trim().toLowerCase().replace('_', '-').startsWith('ru') ? 'ru' : 'en';
