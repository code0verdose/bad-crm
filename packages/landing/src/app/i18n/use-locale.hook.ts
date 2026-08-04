import { useContext } from 'react';

import { LocaleContext, type LocaleState } from './locale.context.js';

/** The page's single entry point to copy and to the language switch. */
export const useLocale = (): LocaleState => {
  const state = useContext(LocaleContext);

  if (!state) {
    throw new Error('useLocale must be used inside <LocaleProvider>.');
  }

  return state;
};
