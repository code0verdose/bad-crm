import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { readStored, writeStored } from '@/shared/lib/storage.util.js';

import { EN_COPY } from './dictionary-en.constant.js';
import { RU_COPY } from './dictionary-ru.constant.js';
import { detectLocale, LOCALE_STORAGE_KEY } from './detect-locale.util.js';
import { LocaleContext, type LocaleState } from './locale.context.js';
import { type Copy, type Locale } from './locale.types.js';

const DICTIONARIES: Record<Locale, Copy> = { en: EN_COPY, ru: RU_COPY };

/**
 * The language switch, and one of the two places the page remembers something (the other is the
 * cookie answer). Both go through `shared/lib/storage.util.ts`, so a browser with storage blocked
 * loses the preference instead of the page.
 *
 * Detection runs once as the initial state rather than in an effect: an effect would render the
 * page in English first and swap it a frame later, which is the flash of wrong language.
 */
export const LocaleProvider = ({ children }: { children: ReactNode }) => {
  const [locale, setLocaleState] = useState<Locale>(() =>
    detectLocale(readStored(LOCALE_STORAGE_KEY), navigator.languages),
  );

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    writeStored(LOCALE_STORAGE_KEY, next);
  }, []);

  // A genuine side effect on an external system: the `lang` attribute is what a screen reader reads
  // pronunciation rules from, and it lives on an element React does not own.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<LocaleState>(
    () => ({ locale, copy: DICTIONARIES[locale], setLocale }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
};
