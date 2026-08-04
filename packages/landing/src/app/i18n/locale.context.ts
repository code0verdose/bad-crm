import { createContext } from 'react';

import { type Copy, type Locale } from './locale.types.js';

export interface LocaleState {
  locale: Locale;
  /** The whole dictionary for the active language. Sections read `copy.hero.title` directly. */
  copy: Copy;
  setLocale: (locale: Locale) => void;
}

/**
 * `null` rather than a default dictionary: a component rendered outside the provider is a wiring
 * mistake, and a silent English fallback would hide it until somebody noticed the page stopped
 * switching languages.
 */
export const LocaleContext = createContext<LocaleState | null>(null);
