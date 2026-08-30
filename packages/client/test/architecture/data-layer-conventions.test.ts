/**
 * @vitest-environment node
 *
 * Two conventions of the data layer that a type cannot express and that fail silently when broken:
 * a query key written by hand, and a credential written to Web Storage. ESLint catches the second
 * per file; neither is caught by anything if a directory stops matching a glob, so both are also
 * asserted over the tree that actually ships.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

const sourceFiles = (directory: string = SRC): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) return [];

    return [path];
  });

const relative = (path: string): string => path.slice(SRC.length + 1);

/**
 * Both patterns below are about code, and both words appear in prose that explains why they are
 * forbidden — the module that keeps the token in memory names `localStorage` in the comment saying
 * it must not be used. Scanning the comments too would make the rule unexplainable.
 */
const stripComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '');

const codeOf = (path: string): string => stripComments(readFileSync(path, 'utf8'));

/**
 * `queryKey: [` — the literal array that `rules/tanstack-query.mdc` §2 forbids.
 *
 * The failure it prevents is invisible: `invalidateQueries({ queryKey: QueryKeys.Tasks.all })`
 * matches by prefix, so a hook that spelled its own key keeps serving stale data after a mutation
 * and nothing reports it. Not a type error, not a warning — a screen that is wrong until reload.
 */
const AD_HOC_QUERY_KEY = /queryKey\s*:\s*\[/;

/** Web Storage survives a tab close and is readable by any script on the page (invariant 3). */
const PERSISTENT_STORAGE = /\b(?:localStorage|sessionStorage)\b/;

describe('the ad-hoc key detector', () => {
  it.each([
    ['a literal array', "useQuery({ queryKey: ['tasks', id] })"],
    ['a literal array with padding', 'useQuery({ queryKey  :  [ "tasks" ] })'],
  ])('rejects %s', (_case, source) => {
    expect(AD_HOC_QUERY_KEY.test(source)).toBe(true);
  });

  it.each([
    ['a key from the factory', 'useQuery({ queryKey: QueryKeys.Tasks.list(params) })'],
    ['a key held in a variable', 'const key = QueryKeys.Tasks.all;\nuseQuery({ queryKey: key })'],
  ])('accepts %s', (_case, source) => {
    expect(AD_HOC_QUERY_KEY.test(source)).toBe(false);
  });
});

/**
 * The stripper is the one step between the tree and both rules, and it is the one step whose
 * failure mode is silent: it returns a string either way, and a string with nothing in it matches
 * no pattern, so both assertions below go green over a tree it has emptied. Every source file here
 * opens with a doc block, so «the comments were removed» and «the file was removed» look the same
 * from the assertions' side.
 *
 * Two controls, because one is not enough. The fixture pins the shape — two comments in one file,
 * which is where a greedy quantifier starts eating the code between them — and the tree control
 * pins the result on the sources actually walked, so a stripper that survives the fixture and
 * destroys the tree still fails here.
 */
describe('the comment stripper (CONTROL)', () => {
  it('removes the comments and keeps the code between and after them', () => {
    expect(
      stripComments(
        ['/** never localStorage */', 'const a = 1;', '/* nor sessionStorage */', 'const b = 2;'] //
          .join('\n'),
      ).replaceAll(/\s+/g, ' '),
    ).toBe(' const a = 1; const b = 2;');
  });

  it('leaves the walked tree with code in it', () => {
    // Not a count of files but a fact about their contents: something in the tree still says
    // `QueryKeys.` after stripping. A stripper that ate the sources reports nothing and both rules
    // below would then pass by finding nothing to fault.
    const usingTheFactory = sourceFiles().filter((path) => /QueryKeys\./.test(codeOf(path)));

    expect(usingTheFactory).not.toEqual([]);
  });
});

describe('the client tree', () => {
  it('has sources to check, so this file cannot pass over an empty tree', () => {
    expect(sourceFiles().length).toBeGreaterThan(0);
  });

  it('builds every query key through the central factory', () => {
    const offenders = sourceFiles()
      .filter((path) => AD_HOC_QUERY_KEY.test(codeOf(path)))
      .map(relative);

    expect(offenders, 'use QueryKeys.<Group>.list/detail — rules/tanstack-query.mdc §2').toEqual(
      [],
    );
  });

  it('keeps every credential out of Web Storage', () => {
    const offenders = sourceFiles()
      .filter((path) => PERSISTENT_STORAGE.test(codeOf(path)))
      .map(relative);

    expect(
      offenders,
      'tokens live in memory plus an httpOnly cookie — CLAUDE.md invariant 3',
    ).toEqual([]);
  });
});
