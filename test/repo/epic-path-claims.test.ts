import { describe, expect, it } from 'vitest';

import {
  FOREIGN_PATHS,
  checkedItems,
  claimKey,
  pathClaims,
  repoTree,
  resolves,
  type PathClaim,
} from './epic-path-claims.util.js';
import { listRepoFiles, readRepoFile } from './repo-fixture.util.js';

/** Computed once: the tree walk is the expensive half and every assertion below wants the same one. */
const once = <T>(compute: () => T): (() => T) => {
  let value: T | undefined;

  return () => (value ??= compute());
};

const tree = once(repoTree);

const epicFiles = (): string[] =>
  listRepoFiles('epics')
    .filter((path) => path.endsWith('.md'))
    .sort();

const allClaims = once((): PathClaim[] =>
  epicFiles().flatMap((path) => pathClaims(path, readRepoFile(path))),
);

/**
 * Ticked items naming a path this checkout does not have — every one of them, with the reason.
 *
 * Empty, and that is the intended resting state rather than an accident of today. Unlike the
 * registries in `runbook-claims.test.ts` and `declared-checks.test.ts`, which exist because a
 * document may legitimately describe an installation ahead of the code, an entry here is an
 * admission that a **tick is wrong** — a claim that work is finished when the file it names is not
 * in the tree. The remedy is to untick the item and say in the same breath what is actually there,
 * which is what the fix of 2026-08-30 did to a hundred and twelve of them; an entry buys time and
 * nothing else.
 *
 * It is kept for the property the two suites above are built on: a declared gap that has since been
 * closed fails exactly as loudly as an undeclared one. A registry that only ever grows is the same
 * lying document pointing the other way.
 */
const PENDING: Readonly<Record<string, string>> = {};

describe('the reader takes paths out of ticked items and nothing else', () => {
  const FIXTURE = [
    '# Fixture',
    '',
    'Прозой: packages/server/src/nope.ts и `docs/README.md` вне пункта — не заявки.',
    '',
    '## Задачи',
    '',
    '- [x] `packages/shared/src/permissions/permissions.catalog.ts` — каталог целиком.',
    '- [x] Локали `packages/client/src/shared/i18n/locales/{en,ru}/common.json` — обе.',
    '- [x] Длинный пункт, у которого путь переехал на',
    '      продолжение: `test/repo/workspace-layout.test.ts`.',
    '- [x] `docs/api/` — каталог контракта.',
    '- [x] Не пути: `@bad-crm/shared`, `import/no-restricted-paths`, `/api/v1/roles`,',
    '      `application/problem+json`, `pgvector/pgvector:pg16`, `./errors`, `try/catch`.',
    '- [x] Не заявки: `packages/landing/**`, `migrations/*_roles/migration.sql`,',
    '      `.../ru/permissions.json`, `@bad-crm/<name>`.',
    '- [ ] `packages/server/src/application/platform/jobs/count-deprecated.job.ts` — ещё нет.',
    '',
    '```bash',
    'node packages/server/dist/main.js',
    '```',
  ].join('\n');

  const paths = (): string[] => pathClaims('fixture.md', FIXTURE).map((claim) => claim.path);

  it('reads an item as a whole, including its continuation lines', () => {
    expect(checkedItems(FIXTURE)).toHaveLength(6);
    expect(paths()).toContain('test/repo/workspace-layout.test.ts');
  });

  /**
   * The false positive that would end this gate. Measured over `epics/**` on 2026-08-30: reading
   * any path-shaped token from anywhere on a ticked line reports 595 findings, against 112 for this
   * reader. Prose is where nearly all of that difference lives.
   */
  it('reads nothing out of prose, out of a fence, or out of an unticked item', () => {
    expect(paths()).not.toContain('packages/server/src/nope.ts');
    expect(paths()).not.toContain('packages/server/dist/main.js');
    expect(paths()).not.toContain(
      'packages/server/src/application/platform/jobs/count-deprecated.job.ts',
    );
  });

  it('reads a path named in inline code', () => {
    expect(paths()).toContain('packages/shared/src/permissions/permissions.catalog.ts');
  });

  it('reads a directory named by a known root', () => {
    expect(paths()).toContain('docs/api');
  });

  it('expands a brace alternation into both paths it stands for', () => {
    expect(paths()).toContain('packages/client/src/shared/i18n/locales/en/common.json');
    expect(paths()).toContain('packages/client/src/shared/i18n/locales/ru/common.json');
  });

  /**
   * Seven shapes that contain a slash and are not paths: a package specifier, a lint rule, a route
   * template, a MIME type, a docker image, a module specifier and a piece of English. None of them
   * is exempted by name — each fails the shape test, which is why the exemption list stays short
   * enough to be read.
   */
  it.each([
    '@bad-crm/shared',
    'import/no-restricted-paths',
    '/api/v1/roles',
    'application/problem+json',
    'pgvector/pgvector:pg16',
    './errors',
    'try/catch',
  ])('does not read `%s` as a path', (token) => {
    expect(paths()).not.toContain(token);
  });

  it.each([
    'packages/landing/**',
    'migrations/*_roles/migration.sql',
    '.../ru/permissions.json',
    '@bad-crm/<name>',
  ])('skips the placeholder form `%s` instead of guessing at it', (token) => {
    expect(paths().some((path) => path.includes(token.replace(/[*<>]|\.\.\./g, '')))).toBe(false);
  });

  it('explains every token exempted by name', () => {
    for (const [path, reason] of Object.entries(FOREIGN_PATHS)) {
      expect(reason.length, path).toBeGreaterThan(40);
    }
  });
});

describe('every path a ticked item names exists in this checkout', () => {
  /**
   * The floor, and the reason every green below means anything.
   *
   * A reader that stopped reading — a changed marker, a regex that quietly matches nothing — passes
   * every assertion in this file over an empty set and reports «0 расхождений» in the voice of a
   * gate that checked the whole corpus.
   */
  it('extracts a non-trivial number of claims', () => {
    expect(allClaims().length).toBeGreaterThan(300);
  });

  it('reads every epic and story file in the tree', () => {
    expect(epicFiles().length).toBeGreaterThan(100);

    const withClaims = new Set(allClaims().map((claim) => claim.file));

    expect(withClaims.size).toBeGreaterThan(40);
  });

  /**
   * The control on the resolver, both ways round, and on both forms a story writes. Without the
   * negative half a resolver that says yes to everything looks like a corpus with nothing wrong in
   * it; without the positive half a resolver that says no to everything looks like a corpus that is
   * entirely wrong.
   */
  it.each([
    ['packages/shared/src/permissions/permissions.catalog.ts', true],
    ['packages/shared/src/permissions/permissions.catalogue.ts', false],
    ['test/repo/workspace-layout.test.ts', true],
    ['test/repo/workspace-layouts.test.ts', false],
    ['src/permissions/permissions.catalog.ts', true],
    ['permissions/permissions.catalog.ts', true],
    ['catalog.ts', false],
    ['docs/api', true],
    ['docs/apis', false],
  ] as const)('resolves `%s` to %s', (path, expected) => {
    expect(resolves(tree(), path)).toBe(expected);
  });

  /** The worktree of a parallel agent is a second checkout, not this one. */
  it('does not resolve a path against a worktree copy of the repository', () => {
    expect([...tree()].some((path) => path.includes('/worktrees/'))).toBe(false);
  });

  it('holds every ticked item the repository has not declared as pending', () => {
    const broken = allClaims()
      .filter((claim) => !resolves(tree(), claim.path))
      .filter((claim) => PENDING[claimKey(claim)] === undefined);

    expect(
      broken.map((claim) => `${claimKey(claim)}  ←  ${claim.span}`),
      'a ticked task names a path this checkout does not have',
    ).toEqual([]);
  });

  /** The direction that rots: an entry describing a gap somebody has since closed. */
  it('declares nothing as pending that already exists', () => {
    const satisfied = new Set(
      allClaims()
        .filter((claim) => resolves(tree(), claim.path))
        .map(claimKey),
    );

    expect(
      Object.keys(PENDING).filter((key) => satisfied.has(key)),
      'the path exists now; remove the entry from PENDING',
    ).toEqual([]);
  });

  it('declares nothing as pending that the reader no longer produces', () => {
    const known = new Set(allClaims().map(claimKey));

    expect(
      Object.keys(PENDING).filter((key) => !known.has(key)),
      'the story no longer ticks this path; remove the entry from PENDING',
    ).toEqual([]);
  });

  it('gives every pending claim a reason long enough to be one', () => {
    for (const [key, reason] of Object.entries(PENDING)) {
      expect(reason.length, key).toBeGreaterThan(40);
    }
  });
});
