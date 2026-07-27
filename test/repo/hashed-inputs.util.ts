import { listRepoFiles, readRepoFile, recordRead, repoEntryNames } from './repo-fixture.util.js';

/** Characters that are literal in a turbo glob but special in a regular expression. */
const ESCAPED = /[.+^${}()|[\]\\?]/g;

/**
 * Stand-in for `**` while the remaining segments are escaped. A space cannot occur in any of the
 * globs turbo accepts here, so it can be recognised again once escaping is done.
 */
const ANY_DEPTH = ' ';

const segmentToSource = (segment: string): string =>
  segment.replace(ESCAPED, String.raw`\$&`).replaceAll('*', '[^/]*');

/**
 * Compiles a turbo `inputs` glob into a regular expression.
 *
 * Only the two wildcards these globs use are supported, with turbo's meaning: `*` stays inside one
 * path segment, `**` spans zero or more whole segments. Zero matters — `packages/{pkg}/src/**` has to
 * cover `packages/server/src/env.ts` and not only files nested deeper — and it is exactly the case
 * a naive `.*` translation gets wrong in the safe-looking direction.
 */
const globToRegExp = (pattern: string): RegExp => {
  const source = pattern
    .split('/')
    .map((segment) => (segment === '**' ? ANY_DEPTH : segmentToSource(segment)))
    .join('/')
    .replace(new RegExp(`^${ANY_DEPTH}/`), '(?:[^/]+/)*')
    .replaceAll(`/${ANY_DEPTH}`, '(?:/[^/]+)*');

  return new RegExp(`^${source}$`);
};

/** Whether a repository-relative path is covered by one turbo glob. */
export const matchesGlob = (pattern: string, path: string): boolean =>
  globToRegExp(pattern).test(path);

/** The paths among `reads` that no entry of `hashed` covers — the cache holes, by name. */
export const unhashedReads = (hashed: readonly string[], reads: readonly string[]): string[] =>
  reads.filter((path) => !hashed.some((pattern) => matchesGlob(pattern, path)));

/** Extensions an import specifier may really resolve to, in the order TypeScript would try them. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', ''] as const;

/** `from '…'`, `import '…'` and `import('…')` — every form the suite uses. */
const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

/** Resolves the `.` and `..` segments of a POSIX path without touching the filesystem. */
const normalisePosix = (path: string): string => {
  const segments: string[] = [];

  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }

  return segments.join('/');
};

/** Existence probe by directory listing: guessing an extension must not record a read. */
const existsInRepo = (relativePath: string): boolean => {
  const separator = relativePath.lastIndexOf('/');
  // A repository-root file has no separator at all, and its directory is the root itself.
  const directory = separator === -1 ? '.' : relativePath.slice(0, separator);

  try {
    return repoEntryNames(directory).includes(relativePath.slice(separator + 1));
  } catch {
    return false;
  }
};

/**
 * Repository files the suite pulls in through `import` rather than through `readRepoFile`.
 *
 * Two suites depend on sources they never open as text: `env-example-sync.test.ts` imports both env
 * schemas out of `packages/{pkg}/src/**`, and `coverage-contract.test.ts` imports all four
 * `vitest.config.ts` files. Those are reads in every sense a cache key cares about — edit one and
 * the assertions change — but no `readFileSync` records them, so they are recovered statically from
 * the import statements of `test/**`.
 *
 * The scan is deliberately one level deep: it resolves what `test/**` imports directly, not the
 * transitive graph. Everything reachable from those entry points lives under `packages/{pkg}/src/**`,
 * which is hashed as a whole tree, so walking further would add no coverage — only a module
 * resolver to maintain. Anything outside that tree is reached through an import written in
 * `test/**`, and that is precisely what this scan reads.
 */
export const importedRepoFiles = (): string[] => {
  const imported = new Set<string>();
  const sources = listRepoFiles('test').filter(
    (path) => path.endsWith('.ts') && !path.startsWith('test/lint/fixtures/'),
  );

  for (const source of sources) {
    const directory = source.slice(0, source.lastIndexOf('/'));

    for (const [, specifier] of readRepoFile(source).matchAll(IMPORT_SPECIFIER)) {
      if (specifier === undefined || !specifier.startsWith('.')) continue;

      const resolved = normalisePosix(`${directory}/${specifier}`);
      // Imports that stay inside `test/**` are already covered by the `test/**` input.
      if (resolved.startsWith('test/')) continue;

      // A Node ESM specifier carries the emitted `.js`; the file on disk — and in the cache key —
      // is the `.ts` beside it.
      const base = resolved.replace(/\.js$/, '');
      const candidates = SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`);

      imported.add(candidates.find((candidate) => existsInRepo(candidate)) ?? resolved);
    }
  }

  for (const path of imported) recordRead(path);
  return [...imported].sort();
};
