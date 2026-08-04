import { LANGUAGE_STORAGE_KEY } from '@shared/i18n';

/**
 * Tells the application to run in `cimode`, in the application's own terms.
 *
 * The switcher is mounted, so `useLanguage` reads the stored choice and drives
 * `i18n.changeLanguage` on the shared instance — correct behaviour, and the reason the suite has to
 * state a choice. Left unset, the app resolves `en`, pulls the instance out of `cimode`, and every
 * assertion that names a key starts reading it without its namespace: `login.title` where the test
 * says `auth.login.title`.
 *
 * Answering in the app's own terms is the honest fix. Stopping the hook under test, or teaching it
 * that a test environment exists, would mean proving a build nobody ships.
 *
 * Call it after any `localStorage.clear()` and before mounting.
 */
export const setTestLanguage = (tag: string): void => {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, JSON.stringify(tag));
};

export const setCimodeLanguage = (): void => {
  setTestLanguage('cimode');
};
