import { type EN_COPY } from './dictionary-en.constant.js';

/** The two languages the product treats as equals (ADR-0019), and the landing with it. */
export const LOCALES = ['en', 'ru'] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * The shape of the page's copy, inferred from English rather than declared by hand.
 *
 * This is the whole of the landing's i18n gate: `dictionary-ru.constant.ts` is annotated with this
 * type, so a key added to English and forgotten in Russian is a compile error, and a key removed
 * from English but left in Russian is one too. No runtime check, no `t('a.b.c')` string that can be
 * mistyped — a section reads `copy.hero.title` and the compiler knows both languages have it.
 */
export type Copy = typeof EN_COPY;
