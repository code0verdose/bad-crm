import i18next from 'i18next';
import { describe, expect, it } from 'vitest';

import { createI18n, LANGUAGES, NAMESPACES } from '@shared/i18n/i18n.config';

/**
 * Every namespace that has a file is actually loaded — and nothing is loaded that has no file.
 *
 * Both directions, because the symptom is the same from either side: an entire feature rendering as
 * its own keys, in both languages, with every other gate green. The parity gate next door compares
 * the JSON catalogues **with each other**, so neither side is visible to it.
 *
 *   * **A namespace in `RESOURCES` that i18next was never told to load.** `ns` was a hand-written
 *     list until this change and it drifted the moment `offboarding` joined `RESOURCES`: the whole
 *     dialog rendered as keys and nothing red said so — it was noticed by looking at the screen,
 *     before the change was committed. `ns` is derived from `RESOURCES` now, and the resolution
 *     cases below are what notice if anyone types the list out again.
 *   * **A catalogue file that never reached `RESOURCES`.** Dropping `feature.json` into
 *     `locales/en` and `locales/ru` satisfies the parity gate for the same reason it always did —
 *     the two directories agree with each other — while no module imports the bundle, no namespace
 *     exists, and the feature renders as keys exactly as above. The listing case is that side: what
 *     is on disk and what is loaded are compared as sets.
 */

/**
 * The locale directories as they are on disk, read through Vite rather than `node:fs`: this suite
 * runs in jsdom, where `import.meta.url` is an `http:` URL and `fileURLToPath` rejects it. The glob
 * is expanded from the real directory at transform time, which is the property being asserted — a
 * hand-kept list here would be the third copy of the same names and would drift with the others.
 */
const CATALOGUE_FILES = import.meta.glob('../../src/shared/i18n/locales/*/*.json');

const filesOf = (language: string): string[] =>
  Object.keys(CATALOGUE_FILES)
    .map((path) => new RegExp(`/locales/${language}/([^/]+)\\.json$`).exec(path)?.[1])
    .filter((namespace): namespace is string => namespace !== undefined)
    .sort();

const firstLeafPath = (value: unknown, trail: string[] = []): string => {
  if (typeof value === 'string') return trail.join('.');

  const [key, nested] = Object.entries(value as Record<string, unknown>)[0] as [string, unknown];

  return firstLeafPath(nested, [...trail, key]);
};

/**
 * The third place the same names could be written out: the test harness.
 *
 * `test/setup/testing-library.setup.ts` initialises the `cimode` instance the whole client suite
 * renders against, and it needs a namespace list of its own. It kept a hand-written one, and that
 * one drifted too — `employee`, `members`, `offboarding` and `teams` were never added. The effect is
 * invisible rather than red: an unregistered namespace is not a namespace, so `nsSeparator` leaves
 * the whole key in `common` and `cimode` answers `common.teams.field.name` where the shipped build
 * renders `teams.field.name`. Every assertion about those screens then describes a string the
 * product cannot produce, and the unanchored regular expressions they use match it happily.
 *
 * So the harness is asserted against the product's derivation, not against a list repeated here —
 * a list here would be the drift, one file further along.
 */
describe('the suite renders against the namespaces the product loads', () => {
  it('registers exactly them in the harness instance', () => {
    // CONTROL: `NAMESPACES` is derived from an object literal, and an empty one would make the
    // comparison below true of nothing.
    expect(NAMESPACES.length).toBeGreaterThan(5);

    expect(
      [...(i18next.options.ns ?? [])].sort(),
      'a hand-written list in the harness resolves unlisted namespaces through `common`',
    ).toEqual([...NAMESPACES].sort());
  });
});

describe.each(LANGUAGES)('translations in %s', (language) => {
  const instance = createI18n(language);
  const bundles = instance.options.resources?.[language] ?? {};

  it('loads the namespaces the locale directory carries, and no others', () => {
    // CONTROL: an empty listing would make the comparison below true of nothing — the glob pattern
    // is the one thing here that can break silently.
    expect(filesOf(language).length).toBeGreaterThan(5);

    expect(
      Object.keys(bundles).sort(),
      `a file in locales/${language} that is not in RESOURCES renders that whole feature as keys`,
    ).toEqual(filesOf(language));
  });

  it.each(Object.keys(bundles))('resolve for namespace %s', (namespace) => {
    const key = `${namespace}.${firstLeafPath(bundles[namespace])}`;

    // CONTROL of the assertion itself: a key from a namespace that does not exist must come back
    // unchanged, otherwise «resolved» would mean nothing.
    expect(instance.t(`no-such-namespace.${key}`)).toBe(`no-such-namespace.${key}`);
    expect(instance.t(key)).not.toBe(key);
  });
});
