/**
 * What the translation catalogues look like right now, as numbers a reviewer can read.
 *
 * The **enforcement** lives in the client suite: `catalogue-parity.test.ts` fails on a key used but
 * missing, present in one language only, or present in neither; `error-codes-parity.test.ts` fails
 * on a server code with no sentence. Re-implementing either here would create a second answer to
 * «is this catalogue complete», and the two would drift the first time one of them was fixed.
 *
 * So this file answers the questions those gates do not. **Untranslated** is one of them: a key can
 * exist in both languages and hold `''`, which every set comparison calls present and every user
 * calls a blank label. The rest is arithmetic — how many keys, how many namespaces, how far each
 * language has got — which nothing fails on and everybody wants to see in a pull request.
 */
export interface CatalogueEntry {
  readonly namespace: string;
  readonly key: string;
  readonly value: string;
}

export interface LanguageSummary {
  readonly language: string;
  readonly keys: number;
  readonly untranslated: readonly string[];
}

export interface I18nSummary {
  readonly namespaces: readonly string[];
  readonly languages: readonly LanguageSummary[];
  /** Keys one language has and another does not, in either direction. */
  readonly unpaired: readonly string[];
}

/** `{ a: { b: 'c' } }` in `common` → `common.a.b`, the way i18next resolves it. */
export const flatten = (
  namespace: string,
  tree: Record<string, unknown>,
  prefix = '',
): CatalogueEntry[] =>
  Object.entries(tree).flatMap(([step, value]) => {
    const key = prefix === '' ? step : `${prefix}.${step}`;

    if (typeof value === 'string') return [{ namespace, key: `${namespace}.${key}`, value }];
    if (typeof value === 'object' && value !== null) {
      return flatten(namespace, value as Record<string, unknown>, key);
    }

    return [];
  });

/**
 * A value nobody has translated yet.
 *
 * Empty and whitespace-only both count. So does a value equal to its own key, because that is what
 * an extractor writes when it has nothing to put there — and it renders exactly like a missing
 * translation while every set comparison reports the key as present.
 */
export const isUntranslated = (entry: CatalogueEntry): boolean =>
  entry.value.trim() === '' || entry.value === entry.key;

/**
 * The suffixes i18next appends to a plural key.
 *
 * Pairing is done on the **base** key, because plural categories are a property of the language:
 * English needs `one` and `other`, Russian needs `one`, `few`, `many` and `other`. Comparing the
 * suffixed forms one-to-one reports a correct Russian catalogue as missing two entries in English —
 * and asks whoever reads the report to «fix» it by deleting a form the language requires.
 */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

export const summarise = (
  catalogues: ReadonlyMap<string, readonly CatalogueEntry[]>,
): I18nSummary => {
  const languages = [...catalogues.keys()].sort();
  const keysOf = (language: string): Set<string> =>
    new Set((catalogues.get(language) ?? []).map((entry) => entry.key.replace(PLURAL_SUFFIX, '')));

  const unpaired = new Set<string>();
  for (const language of languages) {
    for (const other of languages) {
      if (language === other) continue;
      const theirs = keysOf(other);
      for (const key of keysOf(language)) {
        if (!theirs.has(key)) unpaired.add(`${key} (missing in ${other})`);
      }
    }
  }

  return {
    namespaces: [
      ...new Set([...catalogues.values()].flat().map((entry) => entry.namespace)),
    ].sort(),
    languages: languages.map((language) => ({
      language,
      keys: keysOf(language).size,
      untranslated: (catalogues.get(language) ?? [])
        .filter(isUntranslated)
        .map((entry) => entry.key)
        .sort(),
    })),
    unpaired: [...unpaired].sort(),
  };
};

/** The markdown the workflow appends to its job summary. */
export const renderSummary = (summary: I18nSummary): string => {
  const rows = summary.languages.map(
    ({ language, keys, untranslated }) => `| \`${language}\` | ${keys} | ${untranslated.length} |`,
  );

  const problems = [
    ...summary.unpaired.map((entry) => `- unpaired: ${entry}`),
    ...summary.languages.flatMap(({ language, untranslated }) =>
      untranslated.map((key) => `- untranslated (\`${language}\`): ${key}`),
    ),
  ];

  return [
    '## Translations',
    '',
    `Namespaces: ${summary.namespaces.map((namespace) => `\`${namespace}\``).join(', ')}`,
    '',
    '| Language | Keys | Untranslated |',
    '| --- | ---: | ---: |',
    ...rows,
    '',
    problems.length > 0 ? problems.join('\n') : 'Every key is paired and carries a translation.',
    '',
  ].join('\n');
};

/** Non-zero exits the build; the gate is «nothing unpaired and nothing blank». */
export const isClean = (summary: I18nSummary): boolean =>
  summary.unpaired.length === 0 &&
  summary.languages.every(({ untranslated }) => untranslated.length === 0);
