/**
 * @vitest-environment node
 *
 * The gate the whole epic rests on: every key the interface asks for exists in **both** languages.
 *
 * Its absence is the failure mode `docs/product/prd.md` calls R-17 — «двуязычность деградирует до
 * английский + недоперевод». Nothing else catches it: i18next answers a missing key with the key
 * itself, which renders as `auth.login.title` on the screen and as a passing test everywhere else. A
 * reviewer reading a pull request in one language sees nothing wrong at all.
 *
 * So it is asserted in three directions — used but absent, present in one language only, and present
 * in neither used nor loaded — over the tree that ships rather than over a hand-written list.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const LOCALES = `${SRC}/shared/i18n/locales`;

/**
 * Anything that looks like `namespace.some.key` in a string literal of the client — in **either**
 * kind of quote.
 *
 * The double-quoted half was missing when this file was first written, and the omission was not
 * academic: a JSX attribute is conventionally double-quoted, so every `aria-label="…"` and
 * `placeholder="…"` in the tree was invisible to this gate. Those are exactly the strings ADR-0019
 * singles out as the ones that get forgotten, and the gate that exists to find them was looking past
 * them.
 */
const KEY = /['"]([a-z][a-zA-Z]+(?:\.[a-zA-Z][a-zA-Z0-9_]*)+)['"]/g;

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) return [];

    return [path];
  });

/** Every key the source asks for, with the file that asks — so a failure names where to look. */
const usedKeys = (): Map<string, string> => {
  const found = new Map<string, string>();

  for (const file of sourceFiles(SRC)) {
    for (const [, key] of readFileSync(file, 'utf8').matchAll(KEY)) {
      if (key !== undefined && !found.has(key)) found.set(key, file.slice(SRC.length + 1));
    }
  }

  return found;
};

const namespaces = (language: string): string[] =>
  readdirSync(`${LOCALES}/${language}`).map((file) => file.replace(/\.json$/, ''));

/** `auth.json` → `auth.login.title`, `auth.login.submit`, … — flattened the way i18next resolves. */
const flatten = (value: unknown, prefix: string): string[] => {
  if (typeof value === 'string') return [prefix];
  if (typeof value !== 'object' || value === null) return [];

  return Object.entries(value).flatMap(([key, nested]) => flatten(nested, `${prefix}.${key}`));
};

/**
 * The suffixes i18next appends to a plural key, in the two languages this product ships.
 *
 * `t('roles.draft.count', { count })` resolves to `count_one` or `count_other` in English and to one
 * of four forms in Russian: the base key is what the source asks for and never exists in the file.
 * Without this the gate reports every plural as missing **and** every form as unused — two failures
 * for a catalogue that is correct, which is the kind of noise that gets a gate switched off.
 */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** What the source may ask for: every entry, plus the base key of every plural form. */
const cataloguedKeys = (language: string): Set<string> => {
  const entries = namespaces(language).flatMap((namespace) =>
    flatten(
      JSON.parse(readFileSync(`${LOCALES}/${language}/${namespace}.json`, 'utf8')),
      namespace,
    ),
  );

  return new Set(entries.flatMap((key) => [key, key.replace(PLURAL_SUFFIX, '')]));
};

describe('the translation catalogues', () => {
  it('CONTROL: finds keys in the source and entries in both catalogues', () => {
    // Without this every assertion below is vacuously true the day a directory is renamed.
    expect(usedKeys().size).toBeGreaterThan(20);
    expect(cataloguedKeys('en').size).toBeGreaterThan(20);
    expect(cataloguedKeys('ru').size).toBeGreaterThan(20);
    // CONTROL for the plural rule itself: the catalogues really do carry suffixed forms, so the
    // two assertions below are exercising it rather than passing on an empty case.
    expect([...cataloguedKeys('ru')].some((key) => PLURAL_SUFFIX.test(key))).toBe(true);
  });

  it('carries the same namespaces in both languages', () => {
    expect(namespaces('ru').sort()).toEqual(namespaces('en').sort());
  });

  it.each(['en', 'ru'])('translates every key the interface asks for — %s', (language) => {
    const catalogued = cataloguedKeys(language);
    const missing = [...usedKeys()]
      .filter(([key]) => !catalogued.has(key))
      .map(([key, file]) => `${key} (${file})`);

    expect(
      missing,
      `these keys are used and have no ${language} translation — i18next would render the key itself`,
    ).toEqual([]);
  });

  /**
   * The other direction, and it is not tidiness: an entry nobody asks for is either a key that was
   * renamed in the code and left here, or a feature that was removed. Both make the catalogue lie
   * about what the product says, and both hide the *next* missing translation in the noise.
   */
  it.each(['en', 'ru'])('carries no entry the interface never asks for — %s', (language) => {
    const used = new Set(usedKeys().keys());

    // A plural form is asked for through its base key, so `count_few` counts as used when
    // `roles.draft.count` appears in the source — and stops counting the moment that call goes.
    expect(
      [...cataloguedKeys(language)].filter((key) => !used.has(key.replace(PLURAL_SUFFIX, ''))),
    ).toEqual([]);
  });
});
