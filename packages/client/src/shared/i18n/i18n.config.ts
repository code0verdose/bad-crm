import i18next, { type i18n } from 'i18next';
import { initReactI18next } from 'react-i18next';

import enAuth from './locales/en/auth.json' with { type: 'json' };
import enRoles from './locales/en/roles.json' with { type: 'json' };
import enDashboard from './locales/en/dashboard.json' with { type: 'json' };
import enFilter from './locales/en/filter.json' with { type: 'json' };
import enCommon from './locales/en/common.json' with { type: 'json' };
import enErrors from './locales/en/errors.json' with { type: 'json' };
import enEmployee from './locales/en/employee.json' with { type: 'json' };
import enMembers from './locales/en/members.json' with { type: 'json' };
import enOffboarding from './locales/en/offboarding.json' with { type: 'json' };
import enNav from './locales/en/nav.json' with { type: 'json' };
import enPagination from './locales/en/pagination.json' with { type: 'json' };
import enValidation from './locales/en/validation.json' with { type: 'json' };
import ruAuth from './locales/ru/auth.json' with { type: 'json' };
import ruRoles from './locales/ru/roles.json' with { type: 'json' };
import ruDashboard from './locales/ru/dashboard.json' with { type: 'json' };
import ruFilter from './locales/ru/filter.json' with { type: 'json' };
import ruCommon from './locales/ru/common.json' with { type: 'json' };
import ruErrors from './locales/ru/errors.json' with { type: 'json' };
import ruEmployee from './locales/ru/employee.json' with { type: 'json' };
import ruMembers from './locales/ru/members.json' with { type: 'json' };
import ruOffboarding from './locales/ru/offboarding.json' with { type: 'json' };
import ruNav from './locales/ru/nav.json' with { type: 'json' };
import ruPagination from './locales/ru/pagination.json' with { type: 'json' };
import ruValidation from './locales/ru/validation.json' with { type: 'json' };

/** The two the product ships. Order matters only for the fallback chain below. */
export const LANGUAGES = ['en', 'ru'] as const;

export type Language = (typeof LANGUAGES)[number];

const RESOURCES = {
  en: {
    auth: enAuth,
    dashboard: enDashboard,
    roles: enRoles,
    common: enCommon,
    errors: enErrors,
    employee: enEmployee,
    filter: enFilter,
    members: enMembers,
    offboarding: enOffboarding,
    nav: enNav,
    pagination: enPagination,
    validation: enValidation,
  },
  ru: {
    auth: ruAuth,
    dashboard: ruDashboard,
    roles: ruRoles,
    common: ruCommon,
    errors: ruErrors,
    employee: ruEmployee,
    filter: ruFilter,
    members: ruMembers,
    offboarding: ruOffboarding,
    nav: ruNav,
    pagination: ruPagination,
    validation: ruValidation,
  },
};

/**
 * The translation instance of this tab.
 *
 * **`nsSeparator: '.'` is the decision this whole layout rests on**, and it was verified rather than
 * assumed: i18next splits a key on the *first* separator, so `auth.login.title` resolves as
 * namespace `auth` and key `login.title`, and `keySeparator` then walks the nesting. That is what
 * lets a key read as one hierarchical path everywhere in the code — the form ADR-0019 prescribes —
 * while the files stay split per namespace, which is what makes lazy loading per route chunk
 * possible later.
 *
 * **A missing key renders as the key.** i18next's default, kept deliberately: it degrades to exactly
 * what the interface showed before this layer existed, so a gap is visible on the screen instead of
 * being an empty element. `test/i18n/catalogue-parity.test.ts` is what stops one reaching a user.
 *
 * **`ru` falls back to `en`, and that is not a translation policy.** The parity gate makes the
 * fallback unreachable for any key the interface asks for; it exists for the seconds between adding
 * a key and adding its Russian text, when the alternative is a raw key on the screen.
 */
export const createI18n = (language: Language = 'en'): i18n => {
  const instance = i18next.createInstance();

  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    // Derived, never typed out. A hand-kept copy of these names is a list that drifts silently: a
    // namespace present in `RESOURCES` and missing here loads nothing, and every string of that
    // feature renders as its own key — on the screen, in both languages, with the parity gate still
    // green (it compares the JSON files with each other, not with this list). The drift happened
    // here, in this change: `offboarding` was added to `RESOURCES` and to both catalogues while this
    // list — written out by hand until now — still ended at `employee`. Nothing red said so; it was
    // noticed by looking at what the dialog rendered. Deriving the list is what removes the second
    // place to keep in step, and `test/i18n/namespace-registration.test.ts` is what notices if
    // anyone types the names out again.
    ns: Object.keys(RESOURCES.en),
    defaultNS: 'common',
    nsSeparator: '.',
    keySeparator: '.',
    resources: RESOURCES,
    interpolation: {
      // React escapes what it renders; escaping again turns « into &laquo; on the screen.
      escapeValue: false,
    },
  });

  return instance;
};
