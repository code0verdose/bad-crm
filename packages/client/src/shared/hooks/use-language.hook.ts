import { useLocalStorage } from '@mantine/hooks';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { LANGUAGE_STORAGE_KEY, resolveLanguage, type Language } from '@shared/i18n';

export const LANGUAGE_LABEL_KEY: Record<Language, string> = {
  en: 'common.appearance.language.en',
  ru: 'common.appearance.language.ru',
};

export interface LanguageState {
  readonly language: Language;
  readonly setLanguage: (value: Language) => void;
}

/**
 * The language of this tab: remembered, applied immediately, and announced to the document.
 *
 * **The default is resolved, not `'en'`.** `useLocalStorage` needs a value for a first visit, and a
 * literal there would mean a Russian-speaking visitor sees English until they find the switcher —
 * the browser's own setting says otherwise and is free to read. `resolveLanguage` is that whole
 * order in one call.
 *
 * **`getInitialValueInEffect: false`** for the same reason the density hook uses it: the default is
 * to read storage *after* mount, which paints one frame in the wrong language and then replaces
 * every string on the screen. The acceptance criterion is literally «no flash of English».
 *
 * **The two effects are effects, and both are the legitimate kind** — a synchronisation with
 * something outside React (`rules/frontend-fsd.mdc`, anti-`useEffect`). `i18n.changeLanguage` drives
 * a library instance; `<html lang>` is an attribute of a document React does not own. Neither is
 * derived state, and neither can be computed during render.
 */
export const useLanguage = (): LanguageState => {
  const { i18n } = useTranslation();
  const [language, setLanguage] = useLocalStorage<Language>({
    key: LANGUAGE_STORAGE_KEY,
    defaultValue: resolveLanguage(),
    getInitialValueInEffect: false,
  });

  // Imperative, on a library instance React does not own: `changeLanguage` swaps the active
  // catalogue inside i18next and notifies its own subscribers. Nothing is derived here and there is
  // nothing to clean up — the instance outlives this hook and is torn down with the provider.
  useEffect(() => {
    if (i18n.language !== language) void i18n.changeLanguage(language);
  }, [i18n, language]);

  // Imperative DOM on an element outside the React tree: `<html>` is written by `index.html`, not
  // rendered here. Read by screen readers to pick a voice and by the browser to pick hyphenation —
  // wrong here, and a Russian page is read aloud with English pronunciation. No cleanup: the
  // attribute is state of the document, and removing it on unmount would leave it unset.
  useEffect(() => {
    globalThis.document?.documentElement.setAttribute('lang', language);
  }, [language]);

  return { language, setLanguage };
};
