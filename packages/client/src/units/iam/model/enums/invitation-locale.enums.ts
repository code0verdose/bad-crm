import { LOCALES, type Locale } from '@bad-crm/shared/validation';

/**
 * The languages an invitation can be written in, with the key that names each one.
 *
 * A literal map rather than `t(\`members.language.${locale}\`)`: a key built at runtime is invisible
 * to `test/i18n/catalogue-parity.test.ts`, which reads the source for keys and reports anything it
 * cannot find as an entry nobody asks for. The gate is right to — a key it cannot see is a key that
 * can be deleted without anything failing until somebody opens the screen.
 */
export const INVITATION_LOCALE_LABEL: Readonly<Record<Locale, string>> = {
  en: 'members.language.en',
  ru: 'members.language.ru',
};

export const INVITATION_LOCALES = LOCALES;

/**
 * Which language to offer for the letter, given the language the interface is in.
 *
 * `ru` for Russian and English for everything else — the same narrowing the server applies to
 * `users.locale`, kept here so the two ends of one decision cannot drift. It is a function rather
 * than a ternary in the component because a component is markup and handlers
 * (`rules/frontend-fsd.mdc` rule 7), and because this is the one line of it worth a test.
 */
export const invitationLocaleOf = (language: string): Locale =>
  language.trim().toLowerCase().startsWith('ru') ? 'ru' : 'en';
