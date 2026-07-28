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
const codeOf = (path: string): string =>
  readFileSync(path, 'utf8')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\/\/.*$/gm, '');

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
