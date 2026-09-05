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
 * So it is asserted in four directions — used but absent, declared but absent, present in one
 * language only, and present in neither used nor loaded — over the trees that ship rather than over
 * a hand-written list.
 *
 * **A screen is not the only thing that asks.** A form message is declared where the check that
 * refuses lives, and eleven schema files' worth of those checks live in
 * `packages/shared/src/validation`: the `error` of a
 * zod schema is an i18n key by the time `SharedLib.translateFormIssues` is done with it. Reading the
 * client alone made this gate hostile to exactly those keys — the sentence for a 129-character
 * password could not be added without being called an orphan — so the declaration tree is read too.
 * `packages/server/src` deliberately is **not**: a validator there produces `errors[].message`,
 * which `packages/shared/src/errors/validation-issue.enums.ts` reserves for the developer reading a
 * log, while the user's sentence is chosen from `errors[].code` through `VALIDATION_ISSUE_MESSAGE_KEY`.
 * Those strings are key-shaped and are not keys; counting them here would demand sentences for text
 * nobody renders and would let a real orphan hide behind one.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { dottedKeyLiterals } from '../../../../scripts/ci/i18n-unused.util.js';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const LOCALES = `${SRC}/shared/i18n/locales`;
/** Where the form messages of the client are declared — the same directory `pnpm i18n:unused` reads. */
const SCHEMAS = fileURLToPath(new URL('../../../shared/src/validation', import.meta.url));

/**
 * The keys awaiting a sentence, written out rather than filtered quietly.
 *
 * A schema key that no form renders has nowhere to be shown, and inventing text for a screen that
 * does not exist is how a catalogue fills with sentences nobody has read. It is still a debt, so it
 * is named here with the reason — and the registry cannot rot: the last case of this file fails on
 * an entry no schema declares any more and on an entry that has since been translated.
 *
 * `pnpm i18n:unused` prints the same set as `deferred`, computed from the same directory. This is
 * the half that decides what may stay untranslated; that one is the report.
 *
 * What it cannot see, and what the reason of each line therefore has to stay true about: a key that
 * *starts* being rendered. A form switching from its own message to `timezoneSchema` would put the
 * key on a screen while its line here keeps it exempt — nothing in the tree spells the key at that
 * point, so no gate notices. The reasons below are checked against the code they name, dated by
 * this commit; a line whose consumer appears has to go.
 */
const AWAITING_A_SENTENCE: Readonly<Record<string, string>> = {
  'validation.currency.invalid': 'money has no form until contracts and invoices (M3)',
  'validation.money.invalid_amount': 'money has no form until contracts and invoices (M3)',
  'validation.date.invalid': 'no date field is edited by hand yet (time tracking, M3)',
  'validation.datetime.invalid': 'no date field is edited by hand yet (time tracking, M3)',
  'validation.duration.invalid': 'durations are typed into the timesheet, which does not exist yet',
  'validation.duration.tooLong': 'durations are typed into the timesheet, which does not exist yet',
  'validation.duration.zero': 'durations are typed into the timesheet, which does not exist yet',
  'validation.slug.invalid': 'the one form with a slug declares its own keys (teams.field.slug*)',
  'validation.slug.too_long': 'the one form with a slug declares its own keys (teams.field.slug*)',
  'validation.pagination.invalid': 'no consumer: only its own test imports offsetPageSchema',
  'validation.pagination.invalid_cursor': 'no consumer: only its own test imports cursorPageSchema',
  'validation.pagination.too_large': 'no consumer: only its own test imports offsetPageSchema',
  'validation.sort.invalid_order': 'no consumer: lists use shared/lib/validation, not this one',
  'validation.sort.unknown_field': 'no consumer: lists use shared/lib/validation, not this one',
  'validation.id.invalid': 'a type refusal no form field can produce — an id is never typed',
  'validation.password.invalid':
    'a type refusal no form field can produce — an input gives a string',
  'validation.timezone.invalid': 'the profile form states the field itself, without timezoneSchema',
};

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) return [];

    return [path];
  });

/**
 * Where a key counts as asked for, and it is one parser rather than two.
 *
 * `dottedKeyLiterals` is what `pnpm i18n:unused` parses with — both quotes, comments and import
 * lines stripped. Restating it here would put two answers to «where is this key used» in one
 * repository, which is the drift this pair of gates exists to find in the catalogue.
 *
 * The report's namespace filter is deliberately **not** applied. `taskboard.column.title` — a
 * literal whose namespace does not exist on disk — is a renamed or invented key, and it is exactly
 * what i18next renders back at the user; filtering it away here would leave that class of defect
 * visible to nothing. The price is that every dotted literal under these trees has to be a real key,
 * which the tree already lives with: the constants of
 * `src/shared/lib/validation/*.util.test.ts` are joined at runtime for this reason.
 */
const keysIn = (roots: readonly string[]): Map<string, string> => {
  const found = new Map<string, string>();

  for (const root of roots)
    for (const file of sourceFiles(root))
      for (const key of dottedKeyLiterals(readFileSync(file, 'utf8')))
        if (!found.has(key)) found.set(key, file.slice(root.length + 1));

  return found;
};

/** Every key a screen asks for, with the file that asks — so a failure names where to look. */
const usedKeys = (): Map<string, string> => keysIn([SRC]);

/** Every key a shared zod schema declares: a form message, written where the check that refuses is. */
const declaredKeys = (): Map<string, string> => keysIn([SCHEMAS]);

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
    // The declaration tree separately: a wrong path there reads as «no schema declares anything»,
    // which is silent — every assertion over it would pass on an empty set.
    expect(declaredKeys().size).toBeGreaterThan(10);
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
   * The same demand of a key a schema declares, minus the ones openly awaiting a sentence.
   *
   * Without it the widened reading would be indistinguishable from switching the gate off for this
   * tree: a schema key would stop being an orphan and never have to be translated either. With it,
   * dropping one language of `validation.password.too_long` fails, and so does adding a new
   * `error:` to a schema without either a sentence or a line in the registry above.
   */
  it.each(['en', 'ru'])('translates every key a shared schema declares — %s', (language) => {
    const catalogued = cataloguedKeys(language);
    const missing = [...declaredKeys()]
      .filter(([key]) => !(key in AWAITING_A_SENTENCE) && !catalogued.has(key))
      .map(([key, file]) => `${key} (packages/shared/src/validation/${file})`);

    expect(
      missing,
      `these keys are declared by a schema and have no ${language} sentence — a form would print the key`,
    ).toEqual([]);
  });

  /**
   * The other direction, and it is not tidiness: an entry nobody asks for is either a key that was
   * renamed in the code and left here, or a feature that was removed. Both make the catalogue lie
   * about what the product says, and both hide the *next* missing translation in the noise.
   */
  it.each(['en', 'ru'])('carries no entry the interface never asks for — %s', (language) => {
    const used = new Set([...usedKeys().keys(), ...declaredKeys().keys()]);

    // A plural form is asked for through its base key, so `count_few` counts as used when
    // `roles.draft.count` appears in the source — and stops counting the moment that call goes.
    expect(
      [...cataloguedKeys(language)].filter((key) => !used.has(key.replace(PLURAL_SUFFIX, ''))),
    ).toEqual([]);
  });

  /**
   * The registry is checked against the tree, so a line in it cannot outlive its reason.
   *
   * Both ways it rots: a schema drops the key and the entry stays, or somebody writes the sentence
   * and the entry keeps the key exempt from the assertion above — the second is the one that
   * matters, because it would let the *next* language go missing unnoticed.
   */
  it('keeps no line in the awaiting-a-sentence registry that is no longer true', () => {
    const declared = new Set(declaredKeys().keys());
    const translated = new Set([...cataloguedKeys('en'), ...cataloguedKeys('ru')]);

    expect(Object.keys(AWAITING_A_SENTENCE).filter((key) => !declared.has(key))).toEqual([]);
    expect(Object.keys(AWAITING_A_SENTENCE).filter((key) => translated.has(key))).toEqual([]);
  });
});
