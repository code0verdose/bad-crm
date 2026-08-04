import { type Language } from '@shared/i18n';

/**
 * Which zone the interface renders in: the profile setting, then the browser, then UTC.
 *
 * Storage and transport are ISO 8601 in UTC and display is in the reader's zone
 * (`rules/i18n.mdc` §11) — the two halves of one rule, and this is the display half. The order
 * matters for a distributed team: somebody who has said «I work in Yekaterinburg» has said it about
 * their working day, not about the laptop they happen to be carrying this week.
 *
 * UTC last rather than a throw. `resolvedOptions().timeZone` is required to return an IANA name and
 * always does in a browser; the fallback is for a runtime without full ICU, where rendering a
 * deadline in UTC and saying so is better than rendering nothing.
 *
 * `profile` is a parameter and always `undefined` today — the user profile arrives with EPIC-012.
 */
export const resolveTimeZone = (profile?: string): string => {
  if (profile !== undefined && profile !== '') return profile;

  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return browser === undefined || browser === '' ? 'UTC' : browser;
};

/**
 * The first day of the week, as an ISO weekday (1 = Monday, 7 = Sunday).
 *
 * Written out rather than read from `Intl.Locale.prototype.getWeekInfo`, and that is a measurement
 * rather than a preference: the method is absent in the Node this repository runs on, so a
 * timesheet built on it would lay itself out correctly in a browser and throw in the test suite.
 * Two languages, two answers, one place to change when a third arrives.
 */
export const FIRST_DAY_OF_WEEK: Readonly<Record<Language, 1 | 7>> = {
  en: 7,
  ru: 1,
};
