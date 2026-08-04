/**
 * Every `Intl` call in the client, in one place.
 *
 * The wrappers exist so that the lint rule can exist: `toLocaleDateString`, `toLocaleString` and
 * `Intl.*` are banned outside this folder (`rules/i18n.mdc` §10), because a locale passed by hand at
 * a call site is a locale that stops following the switcher, and a hand-written `dd.MM.yyyy` is a
 * date that reads as the wrong day to half the people who see it.
 */
export * from './date.util.js';
export * from './duration.util.js';
export * from './list.util.js';
export * from './money.util.js';
export * from './number.util.js';
export * from './relative-time.util.js';
export * from './time-zone.util.js';
