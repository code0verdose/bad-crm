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
});
