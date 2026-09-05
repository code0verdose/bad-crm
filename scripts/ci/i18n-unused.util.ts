/**
 * `pnpm i18n:unused` — which catalogued keys nobody asks for, and which asked-for keys nobody wrote.
 *
 * The orphan half is cheap to get wrong in a way that ends the check: keys reach the catalogue
 * through a written-out `ERROR_MESSAGE_KEY` map, a `*_KEY` constant, a `titleKey`/`descriptionKey`
 * prop, an `i18nKey` on `Trans` and the `error` option of a zod schema — and only a minority through
 * `t('…')`. Measured on this repository, a `t()`-only reading calls **333 of 684** keys orphaned (2026-09-06;
 * the pair drifts with the catalogue, which is why the report recomputes it rather than trusting
 * this line);
 * the first pull request opened against that report would have deleted half the interface's text, so
 * the report prints that number beside the real one (`naiveOrphaned`) rather than leaving the
 * calibration to the reader's trust.
 *
 * What the parse does instead: strip comments and import lines — a doc block explaining
 * ``a map rather than `roles.domain.${domain}` `` and a line importing `errors.json` both read as
 * keys otherwise — then take every string literal whose first segment is a real namespace, from
 * every non-test source. Nothing is filtered quietly: the two deliberate exclusions are named in
 * `NOT_PRODUCT_USE` below, and a schema key with no sentence is reported as `deferred` rather than
 * dropped.
 *
 * The set comparisons of `packages/client/test/i18n/catalogue-parity.test.ts` are the neighbouring
 * gate, and the two now read the same two trees through the very parser below: that file imports
 * `dottedKeyLiterals` rather than restating it, because two answers to «where is this key used» is
 * the class of drift both gates exist to find. Two differences remain, and both are this file's:
 * a key referenced only from a test file is not usage in this report, and the namespace filter of
 * `keyLiterals` — which that gate deliberately does without, so that a key in a namespace nobody
 * ships stays visible to something.
 */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export interface AuditInput {
  /**
   * The namespaces the product ships, from the locale directory rather than from the keys below.
   *
   * Deriving them from the catalogue would make the interesting case invisible: a screen asking for
   * `auth.login.title` when `auth.json` holds nothing under `login` is a missing sentence, and a
   * namespace list computed from the keys that *do* exist cannot see a key in a namespace it has
   * not met.
   */
  readonly namespaces: readonly string[];
  /** Every key of the catalogue, flattened the way i18next addresses it, both languages merged. */
  readonly catalogue: readonly string[];
  /** Client sources: what a screen renders. A key asked for here and missing is a defect. */
  readonly screens: readonly SourceFile[];
  /** Shared zod schemas: message keys declared away from any screen. */
  readonly schemas: readonly SourceFile[];
}

export interface I18nUnusedReport {
  readonly catalogued: number;
  readonly used: number;
  /** Catalogued, asked for by nothing. */
  readonly orphaned: readonly string[];
  /** Asked for by a screen, in neither catalogue — the expensive direction. */
  readonly missing: readonly string[];
  /** Named by a shared schema, in neither catalogue. Reported, not failed; see below. */
  readonly deferred: readonly string[];
  /** Built at runtime from a prefix and a variable, so no gate can see it (`rules/i18n.mdc` §3). */
  readonly assembled: readonly string[];
  /** What a `t('…')`-only reading would have called orphaned — the calibration, not a verdict. */
  readonly naiveOrphaned: readonly string[];
}

/**
 * The two exclusions, written out because a quiet filter is how a scanner stops being one.
 *
 * Nothing else is dropped: everything the parse cannot resolve ends up in `assembled` or in
 * `deferred`, both of which are printed.
 */
export const NOT_PRODUCT_USE: Readonly<Record<string, string>> = {
  '*.test.ts, *.test.tsx':
    'A key referenced only by a test is an orphan in the product. Counting the test as use is how ' +
    'a renamed key keeps its old entry alive for as long as the old test survives.',
  'comments and import lines':
    'Both read as keys under any regular expression: `i18n.config.ts` imports fifteen files named ' +
    '`<namespace>.json`, and the doc blocks that explain why a map is used rather than ' +
    '`` `roles.domain.${domain}` `` quote the very shape the assembled-key check looks for.',
};

/** The suffixes i18next appends to a plural key; pairing is done on the base key. */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

export const baseKey = (key: string): string => key.replace(PLURAL_SUFFIX, '');

/** A dotted path in either quote: `common.retry`, `auth.login.title`. */
const KEY_LITERAL = /['"]([a-z][a-zA-Z]+(?:\.[a-zA-Z][a-zA-Z0-9_]*)+)['"]/g;

/** `t('…')` and nothing else — the reading this file exists to be measured against. */
const NAIVE_LITERAL = /\bt\(\s*['"]([a-z][a-zA-Z]+(?:\.[a-zA-Z][a-zA-Z0-9_]*)+)['"]/g;

/** A template whose first segment is a namespace and which interpolates: `` `common.${tone}` ``. */
const ASSEMBLED = /`([a-z][a-zA-Z]+)((?:\.[a-zA-Z0-9_]+)*)\.\$\{[^}]*\}((?:\.[a-zA-Z0-9_]+)*)/g;

/** Comments and import lines out; what is left is code that can hold a key. */
export const stripNonCode = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .filter((line) => !/^\s*(import|export)\b.*\bfrom\b/.test(line))
    .join('\n');

const matches = (source: string, pattern: RegExp): string[] =>
  [...stripNonCode(source).matchAll(pattern)].flatMap(([, captured]) =>
    captured === undefined ? [] : [captured],
  );

const isTestFile = (path: string): boolean => /\.test\.tsx?$/.test(path);

/**
 * Every key-shaped literal, whatever its first segment.
 *
 * The namespace filter belongs to the report below and not to the parse, because
 * `catalogue-parity.test.ts` needs precisely what the filter throws away: a literal like
 * `taskboard.column.title`, whose namespace does not exist on disk, is the shape of a key that was
 * renamed or invented, and it is the one i18next answers with the key itself. Filtering it out
 * there would leave that class visible to no gate at all.
 */
export const dottedKeyLiterals = (source: string): string[] => matches(source, KEY_LITERAL);

/**
 * Every key-shaped literal whose first segment is a namespace this product ships.
 *
 * The filter is this report's, and it is what keeps `missing` readable: the client tree is full of
 * dotted strings that are not keys — `react.transitional.element`, a `path` of a form issue — and a
 * report that lists them beside a real missing sentence stops being read.
 */
export const keyLiterals = (source: string, namespaces: readonly string[]): string[] =>
  dottedKeyLiterals(source).filter((key) => namespaces.includes(key.split('.')[0] ?? ''));

export const naiveKeyLiterals = (source: string): string[] => matches(source, NAIVE_LITERAL);

/** The assembled key, rendered with the hole left visible: `common.${…}.title`. */
export const assembledKeys = (source: string, namespaces: readonly string[]): string[] =>
  [...stripNonCode(source).matchAll(ASSEMBLED)].flatMap((match) => {
    const [, namespace, head, tail] = match;

    if (namespace === undefined || !namespaces.includes(namespace)) return [];

    return [`${namespace}${head ?? ''}.\${…}${tail ?? ''}`];
  });

const collect = (
  files: readonly SourceFile[],
  read: (file: SourceFile) => string[],
): Map<string, string> => {
  const found = new Map<string, string>();

  for (const file of files.filter(({ path }) => !isTestFile(path))) {
    for (const key of read(file)) if (!found.has(key)) found.set(key, file.path);
  }

  return found;
};

export const audit = ({
  namespaces,
  catalogue,
  screens,
  schemas,
}: AuditInput): I18nUnusedReport => {
  const catalogued = new Set(catalogue.map(baseKey));

  const read = (file: SourceFile): string[] => keyLiterals(file.text, namespaces);
  const fromScreens = collect(screens, read);
  const fromSchemas = collect(schemas, read);

  const used = new Set([...fromScreens.keys(), ...fromSchemas.keys()].map(baseKey));
  const naive = new Set(
    [...collect(screens, (file) => naiveKeyLiterals(file.text)).keys()].map(baseKey),
  );

  const absent = (source: Map<string, string>): string[] =>
    [...source]
      .filter(([key]) => !catalogued.has(baseKey(key)))
      .map(([key, path]) => `${key} (${path})`)
      .sort();

  return {
    catalogued: catalogued.size,
    used: used.size,
    orphaned: [...catalogued].filter((key) => !used.has(key)).sort(),
    missing: absent(fromScreens),
    deferred: absent(fromSchemas),
    assembled: [
      ...collect([...screens, ...schemas], (file) => assembledKeys(file.text, namespaces)),
    ]
      .map(([key, path]) => `${key} (${path})`)
      .sort(),
    naiveOrphaned: [...catalogued].filter((key) => !naive.has(key)).sort(),
  };
};

/**
 * What fails the run, and what only appears in it.
 *
 * `deferred` is deliberately not a failure. A key named by a shared zod schema that no form renders
 * yet — every `validation.money.*`, `validation.slug.*` and `validation.pagination.*` in the tree
 * today — has nowhere to be shown and no screen to be shown on, and inventing a sentence for a
 * screen that does not exist fills the catalogue with text nobody has read. It is listed so that the
 * epic which builds the first form over those schemas finds the list already written.
 *
 * The report is one half of that decision and `catalogue-parity.test.ts` is the other: its
 * `AWAITING_A_SENTENCE` registry names the same keys with the reason each is allowed to stay
 * untranslated, and fails on any schema key that is neither translated nor listed. A key that
 * acquires a sentence leaves this list on its own, because both sides are computed from the tree.
 */
export const isClean = (report: I18nUnusedReport): boolean =>
  report.orphaned.length === 0 && report.missing.length === 0 && report.assembled.length === 0;

export const renderReport = (report: I18nUnusedReport): string => {
  const problems = [
    ...report.orphaned.map((key) => `- orphaned: ${key}`),
    ...report.missing.map((entry) => `- used and untranslated: ${entry}`),
    ...report.assembled.map((entry) => `- assembled at runtime: ${entry}`),
  ];

  return [
    '## Unused translations',
    '',
    '| | |',
    '| --- | ---: |',
    `| Catalogued | ${report.catalogued} |`,
    `| Asked for by the product | ${report.used} |`,
    `| Orphaned | ${report.orphaned.length} |`,
    `| Orphaned by a \`t()\`-only reading | ${report.naiveOrphaned.length} |`,
    `| Deferred (schema key, no sentence yet) | ${report.deferred.length} |`,
    '',
    problems.length > 0 ? problems.join('\n') : 'Every catalogued key is asked for by the product.',
    '',
    ...(report.deferred.length > 0
      ? [
          'Deferred — named by a shared schema, rendered by no screen yet:',
          '',
          ...report.deferred.map((entry) => `- ${entry}`),
          '',
        ]
      : []),
  ].join('\n');
};
