/**
 * @vitest-environment node
 *
 * The half of «no hardcoded text» that a JSX rule cannot see.
 *
 * `i18next/no-literal-string` runs in `jsx-only` mode, so it watches markup and attributes. The
 * strings that escape it live in plain TypeScript: a status label map, a column title list, a set of
 * option captions — `const STATUS_LABEL = { open: 'Открыто' }` type-checks, renders, and is
 * monolingual forever. `rules/i18n.mdc` answers it with a shape rather than a ban: these files hold
 * a **key**, and the component calls `t(key)`.
 *
 * The heuristic is deliberately about prose rather than about length. A literal with a space in it,
 * or with a Cyrillic letter in it, is a sentence somebody wrote for a reader; `top-center`,
 * `bc-language` and `auth.login.title` are not. Anything narrower would either miss
 * `'Не найдено'` or flag every CSS token in the tree.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

/** Where a label map is allowed to live, by the naming rule (`rules/naming-and-structure.mdc`). */
const LABEL_MAP_FILE = /\.(enums|constant)\.ts$/;

const filesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) return filesUnder(path);

    return LABEL_MAP_FILE.test(entry.name) ? [path] : [];
  });

const STRING_LITERAL = /'([^'\\\n]*)'|"([^"\\\n]*)"/g;
const CYRILLIC = /\p{Script=Cyrillic}/u;

/** A literal that reads like something written for a person rather than for a machine. */
const isProse = (value: string): boolean => value.trim().includes(' ') || CYRILLIC.test(value);

/**
 * Comments carry prose by design — every file in this repository explains itself — so they are
 * removed before the literals are read. Stripping is crude on purpose: it only has to be right about
 * where a comment starts, and a literal containing `//` would be prose anyway.
 */
const withoutComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');

const proseIn = (path: string): string[] =>
  [...withoutComments(readFileSync(path, 'utf8')).matchAll(STRING_LITERAL)]
    .map(([, single, double]) => single ?? double ?? '')
    .filter(isProse);

describe('label maps and constants', () => {
  it('carry keys, never sentences', () => {
    const offenders = filesUnder(SRC).flatMap((path) =>
      proseIn(path).map((value) => `${path.slice(SRC.length + 1)}: ${JSON.stringify(value)}`),
    );

    expect(offenders).toEqual([]);
  });

  /**
   * CONTROL: the detector has to actually fire. Without this the test above passes just as happily
   * when `isProse` is broken, when the file list is empty, or when the comment stripper eats the
   * whole file — three ways to be green while checking nothing.
   *
   * The third of those was named here and not covered until 2026-08-30: the cases below exercised
   * `isProse` and the file list, and `withoutComments` had nothing pointed at it. A stripper that
   * returns `''` makes every file literal-free and the sweep passes on a codebase full of
   * sentences. It has its own two cases now, and the sweep has one that says it is reading
   * something.
   */
  it.each([
    ['an English sentence', 'Not found'],
    ['a Russian word', 'Открыто'],
  ])('CONTROL: recognises %s as prose', (_case, value) => {
    expect(isProse(value)).toBe(true);
  });

  it.each([
    ['a translation key', 'common.appearance.language.en'],
    ['a storage key', 'bc-language'],
    ['a design token', 'top-center'],
  ])('CONTROL: leaves %s alone', (_case, value) => {
    expect(isProse(value)).toBe(false);
  });

  it('CONTROL: is looking at files that exist', () => {
    expect(filesUnder(SRC).length).toBeGreaterThan(0);
  });

  it('CONTROL: the stripper removes comments and keeps the code around them', () => {
    const source = [
      "const before = 'bc-language';",
      '/* a block comment with a sentence in it */',
      "const between = 'top-center';",
      '// a line comment with another sentence',
      "const after = 'common.appearance.language.en';",
    ].join('\n');

    const stripped = withoutComments(source);

    expect(stripped).toContain("'bc-language'");
    expect(stripped).toContain("'top-center'");
    expect(stripped).toContain("'common.appearance.language.en'");
    expect(stripped).not.toContain('a block comment');
    expect(stripped).not.toContain('a line comment');
  });

  /**
   * CONTROL: and the sweep gets literals out of the real tree.
   *
   * The pair above is about a string this file wrote. This one is about the files it actually
   * reads: a stripper that survives the synthetic case and still empties a source with a licence
   * header, a nested comment, or a comment terminator inside a string would leave the sweep with
   * nothing to judge, and nothing is what it asserts.
   */
  it('CONTROL: finds string literals in the files it sweeps', () => {
    const literals = filesUnder(SRC).flatMap((path) => [
      ...withoutComments(readFileSync(path, 'utf8')).matchAll(STRING_LITERAL),
    ]);

    expect(literals.length).toBeGreaterThan(20);
  });
});
