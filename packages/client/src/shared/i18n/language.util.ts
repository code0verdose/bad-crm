import { LANGUAGES, type Language } from './i18n.config.js';

/** Where the choice lives. Written by `useLocalStorage`, so the value is JSON, not a bare string. */
export const LANGUAGE_STORAGE_KEY = 'bc-language';

const isLanguage = (value: unknown): value is Language =>
  typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);

/**
 * `ru-RU` → `ru`. The region says where somebody is, not which of two languages to speak.
 *
 * Written with `indexOf`/`slice` rather than `split('-')[0]` because the latter is `string |
 * undefined` under `noUncheckedIndexedAccess`, and the `?? ''` it needs is a branch the runtime can
 * never take — `split` always yields at least one element. A fallback that cannot run is a line no
 * test can cover and no reader can evaluate.
 */
const withoutRegion = (tag: string): string => {
  const region = tag.indexOf('-');

  return region === -1 ? tag : tag.slice(0, region);
};

/**
 * What the browser was configured with, or nothing it can act on.
 *
 * Guarded rather than read: this runs before the first paint, and `navigator` is absent in a
 * non-browser runtime — the suite stubs it, and so would any future server render.
 */
const fromNavigator = (): Language | undefined => {
  const reported = globalThis.navigator?.language;

  if (typeof reported !== 'string') return undefined;

  const language = withoutRegion(reported);

  return isLanguage(language) ? language : undefined;
};

/**
 * Which language a tab opens in when nothing has been chosen yet: profile → browser → English.
 *
 * **The saved choice is deliberately not read here.** `useLanguage` holds it through
 * `useLocalStorage`, which reads storage itself and only falls back to this value when the entry is
 * absent — so reading it a second time would be a second answer to the same question. It would also
 * mean touching `globalThis.localStorage` directly, which the architecture test forbids for a good
 * reason: the ban is how «no credential in Web Storage» is enforced across the tree, and an exception
 * for a preference is an exception somebody copies for a token.
 *
 * What is left is an order that still matters. The browser above the default, or a Russian-speaking
 * visitor gets English from a product that has Russian; and something rather than nothing at the end,
 * because i18next answers a missing catalogue with raw keys.
 *
 * `profile` is a parameter and is still passed by nobody: `useLanguage` calls `resolveLanguage()`
 * with no argument. Taking it as an argument makes wiring it a call site instead of a rewrite.
 *
 * The reason given for the gap has expired (2026-08-30). This line said the profile «arrives with
 * EPIC-012»; the language has been stored server-side since EPIC-006's migration
 * `20260728120000_auth_core_identity_and_sessions`, and `SessionUser.locale` carries it in the
 * contract today. Reading it here is open work, not a wait.
 */
export const resolveLanguage = (profile?: string): Language =>
  (isLanguage(profile) ? profile : undefined) ?? fromNavigator() ?? 'en';
