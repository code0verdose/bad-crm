/**
 * @vitest-environment node
 *
 * Every `{{count}}` interpolation either has the plural forms its language grammar needs, or is not
 * an agreement site at all.
 *
 * That second clause is the whole design decision here, so it is written out in full before the
 * code. Russian pluralises the word next to the number (`{{count}} задача/задачи/задач`); English
 * distinguishes only `one`/`other`. But four keys in this catalogue put `{{count}}` at the very end
 * of a report sentence, after a colon, with no word left for it to agree with: «Отозвано сессий: 5»
 * and «Отозвано сессий: 500» are both correct Russian, because the counted noun («сессий») already
 * sits in a fixed genitive-plural form chosen *before* the number, and the number that follows
 * governs nothing. A gate that fails on every bare `{{count}}` would be red on these four today, for
 * no defect — and the fix an author reaches for under a false alarm is not "add real forms", it is
 * "silence the check", which is worse than not having it.
 *
 * So the gate does not ban bare `{{count}}` outright. It asks a narrower, testable question: does
 * anything sit between the count and the end of the string? If yes, that word has to agree, and the
 * key is either a pluralisation family (`_one`/`_few`/`_many`/`_other`) or a defect. If the count is
 * the last thing in the sentence, immediately after a colon, there is nothing to agree with it, and
 * a single literal string is correct Russian and correct English alike.
 *
 * The alternative considered and rejected was a hand-kept exception list of the four keys. It would
 * have caught today's four cases exactly as well, but it says nothing about the fifth: the next
 * author who reaches for the same report-sentence shape has no signal that the pattern is
 * recognised, and the next author who writes `'{{count}} задач закрыто'` — agreement, not a report —
 * has no signal that it *isn't*. A list of four strings, unexplained, is exactly the kind of thing
 * this repository's own testing rule warns will be unreadable in six months. The regex is not
 * shorter to write, but it is the thing that is actually true about Russian grammar, so it keeps
 * working on keys nobody has written yet.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const LOCALES = fileURLToPath(new URL('../../src/shared/i18n/locales', import.meta.url));

const LANGUAGES = ['en', 'ru'] as const;
type Language = (typeof LANGUAGES)[number];

type PluralSuffix = 'one' | 'few' | 'many' | 'other';
const PLURAL_SUFFIX_RE = /_(one|few|many|other)$/;

/** Russian pluralises grammatically (`one/few/many`); English only distinguishes `one/other`. */
const REQUIRED_SUFFIXES: Record<Language, readonly PluralSuffix[]> = {
  en: ['one', 'other'],
  ru: ['one', 'few', 'many'],
};

/**
 * A `{{count}}` that is the last thing in the sentence, right after a colon, governs no word — see
 * the file docstring. `\s*$` (not `$` alone) so a trailing space in the JSON source does not defeat
 * the match; the anchor still requires the count to be the *last* token, so `'Count: {{count}} of 5'`
 * correctly fails it.
 */
const REPORT_TAIL_RE = /:\s*\{\{count\}\}\s*$/u;

interface Leaf {
  readonly path: string;
  readonly value: string;
}

const flatten = (node: unknown, prefix: readonly string[] = []): Leaf[] => {
  if (typeof node === 'string') return [{ path: prefix.join('.'), value: node }];
  if (node === null || typeof node !== 'object') return [];

  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    flatten(value, [...prefix, key]),
  );
};

const namespacesOf = (language: Language): string[] =>
  readdirSync(`${LOCALES}/${language}`).filter((name) => name.endsWith('.json'));

const readNamespace = (language: Language, namespace: string): Leaf[] =>
  flatten(JSON.parse(readFileSync(`${LOCALES}/${language}/${namespace}`, 'utf8')) as unknown);

interface CountedLeaf extends Leaf {
  readonly namespace: string;
}

const countedLeavesOf = (language: Language): CountedLeaf[] =>
  namespacesOf(language).flatMap((namespace) =>
    readNamespace(language, namespace)
      .filter((leaf) => leaf.value.includes('{{count}}'))
      .map((leaf) => ({ ...leaf, namespace })),
  );

interface Family {
  readonly namespace: string;
  readonly base: string;
  readonly suffixes: Set<PluralSuffix>;
}

/**
 * Splits the counted leaves of one language into pluralisation families (siblings under a
 * `_one`/`_few`/`_many`/`_other` suffix) and standalone ("bare") keys. A leaf only ever lands in one
 * of the two: the suffix regex either matches its last path segment or it does not.
 */
const classify = (leaves: readonly CountedLeaf[]): { families: Family[]; bare: CountedLeaf[] } => {
  const families = new Map<string, Family>();
  const bare: CountedLeaf[] = [];

  for (const leaf of leaves) {
    const match = PLURAL_SUFFIX_RE.exec(leaf.path);

    if (!match) {
      bare.push(leaf);
      continue;
    }

    const base = `${leaf.namespace}:${leaf.path.slice(0, match.index)}`;
    const suffix = match[1] as PluralSuffix;
    const family = families.get(base) ?? {
      namespace: leaf.namespace,
      base,
      suffixes: new Set<PluralSuffix>(),
    };

    family.suffixes.add(suffix);
    families.set(base, family);
  }

  return { families: [...families.values()], bare };
};

const bareCountIsLegitimate = (value: string): boolean => REPORT_TAIL_RE.test(value);

const missingForms = (language: Language, family: Family): PluralSuffix[] =>
  REQUIRED_SUFFIXES[language].filter((suffix) => !family.suffixes.has(suffix));

describe.each(LANGUAGES)('%s pluralisation of {{count}}', (language) => {
  const { families, bare } = classify(countedLeavesOf(language));

  it('every bare {{count}} is a trailing report, not a word waiting to agree', () => {
    const offenders = bare
      .filter((leaf) => !bareCountIsLegitimate(leaf.value))
      .map((leaf) => `${language}/${leaf.namespace}#${leaf.path}: ${JSON.stringify(leaf.value)}`);

    expect(offenders).toEqual([]);
  });

  it('every pluralisation family has the forms this language needs', () => {
    const offenders = families.flatMap((family) => {
      const missing = missingForms(language, family);

      return missing.length > 0
        ? [`${language}/${family.namespace}#${family.base} is missing: ${missing.join(', ')}`]
        : [];
    });

    expect(offenders).toEqual([]);
  });

  /**
   * CONTROL: proves the scan actually reached counted keys, on the real catalogue. Without it, an
   * empty `families`/`bare` pair (a broken directory path, a `namespacesOf` returning `[]`) would
   * make both assertions above pass vacuously.
   */
  it('CONTROL: found at least one counted key to check', () => {
    expect(families.length + bare.length).toBeGreaterThan(0);
  });
});

describe('the report-tail heuristic', () => {
  it.each([
    ['a trailing report count in English', 'Sessions revoked: {{count}}', true],
    ['a trailing report count in Russian', 'Отозвано сессий: {{count}}', true],
    ['a count with nothing before the colon but itself', 'Count: {{count}}', true],
    ['a count mid-sentence with no colon at all', '{{count}} sessions closed', false],
    ['a count agreeing with a following Russian word', '{{count}} задача выбрана', false],
    ['a count agreeing with a following English word', '{{count}} sessions revoked', false],
    ['a colon followed by more text after the count', 'Count: {{count}} of 5', false],
  ])('CONTROL: %s -> legitimate = %s', (_case, value, expected) => {
    expect(bareCountIsLegitimate(value)).toBe(expected);
  });
});

describe('family classification', () => {
  it('CONTROL: separates a real family from a bare key in the same namespace', () => {
    const leaves: CountedLeaf[] = [
      { namespace: 'x.json', path: 'a.count_one', value: '{{count}} x' },
      { namespace: 'x.json', path: 'a.count_other', value: '{{count}} xs' },
      { namespace: 'x.json', path: 'b.report', value: 'Done: {{count}}' },
    ];
    const { families, bare } = classify(leaves);

    expect(families).toHaveLength(1);
    expect(families[0]).toMatchObject({
      base: 'x.json:a.count',
      suffixes: new Set(['one', 'other']),
    });
    expect(bare).toHaveLength(1);
    expect(bare[0]?.path).toBe('b.report');
  });

  it.each([
    ['ru', new Set<PluralSuffix>(['one', 'other']), ['few', 'many']],
    ['ru', new Set<PluralSuffix>(['one', 'few', 'many']), []],
    ['en', new Set<PluralSuffix>(['one']), ['other']],
    ['en', new Set<PluralSuffix>(['one', 'other']), []],
  ] as const)('CONTROL: %s family with %j is missing %j', (language, suffixes, expected) => {
    const family: Family = { namespace: 'x.json', base: 'a.count', suffixes: new Set(suffixes) };

    expect(missingForms(language, family)).toEqual(expected);
  });
});
