import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseJsonc } from 'jsonc-parser';

/** Absolute path of the repository root, independent of the working directory of the runner. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PACKAGE_DIRS = {
  shared: 'packages/shared',
  server: 'packages/server',
  client: 'packages/client',
  e2e: 'packages/e2e',
} as const;

export const PACKAGE_NAMES = {
  shared: '@bad-crm/shared',
  server: '@bad-crm/server',
  client: '@bad-crm/client',
  e2e: '@bad-crm/e2e',
} as const;

/**
 * Every repository path the suite has read so far, in this process.
 *
 * `//#test:repo` declares an `inputs` allow-list, and anything missing from it turns the task into
 * a cached PASS over a file it never re-read. That list used to be mirrored by hand in
 * `workspace-layout.test.ts`; within a single epic it fell behind the code three times, because
 * what it actually checked was whether somebody remembered to append a line. This registry replaces
 * remembering with observation: the read itself is what puts the path on the list.
 *
 * The registry is module state, so it only aggregates across test files while they share one module
 * graph — hence `isolate: false` and `fileParallelism: false` in `vitest.config.ts`, plus the
 * sequencer that runs the auditing file last. `workspace-layout.test.ts` asserts that it really is
 * seeing reads made by the other suites, so a future return to parallel isolation fails loudly
 * instead of turning the audit into a self-check over its own handful of reads.
 */
const reads = new Set<string>();

/** Normalises to a repository-relative POSIX path, whatever separator the caller composed. */
const toRepoRelative = (path: string): string =>
  (path.startsWith(repoRoot) ? path.slice(repoRoot.length) : path)
    .replaceAll('\\', '/')
    .replace(/^\/+/, '');

/**
 * Registers a repository file as read by the suite.
 *
 * Called for free by `readRepoFile`/`readJson`; call it directly only for a dependency that is not
 * a `readFileSync` — an `import` of a source file resolved by the module loader, for example.
 */
export const recordRead = (relativePath: string): void => {
  reads.add(toRepoRelative(relativePath));
};

/** Every path recorded so far, sorted, for assertions and failure messages. */
export const recordedReads = (): string[] => [...reads].sort();

/**
 * Reads a repository file as text and records the path.
 *
 * This is the only door: `test/**` may not import `node:fs` (enforced by `eslint.config.js`), so a
 * new read cannot bypass the registry by calling `readFileSync` directly.
 */
export const readRepoFile = (relativePath: string): string => {
  recordRead(relativePath);
  return readFileSync(join(repoRoot, relativePath), 'utf8');
};

/**
 * Every file under a repository directory, depth-first, as repository-relative POSIX paths.
 *
 * Listing a directory is not reading a file, so nothing is recorded here — the caller records what
 * it actually opens.
 */
export const listRepoFiles = (relativeDir: string): string[] =>
  readdirSync(join(repoRoot, relativeDir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${relativeDir}/${entry.name}`;
    return entry.isDirectory() ? listRepoFiles(path) : [path];
  });

/** Names directly inside a repository directory, without descending — a cheap existence probe. */
export const repoEntryNames = (relativeDir: string): string[] =>
  readdirSync(join(repoRoot, relativeDir));

/**
 * Reads a JSON(C) file from the repository. Turbo and TypeScript configs allow comments and
 * trailing commas, so a JSONC parser is used instead of `JSON.parse`.
 */
export const readJson = <T>(relativePath: string): T => {
  const raw = readRepoFile(relativePath);
  const errors: { error: number; offset: number }[] = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true }) as T;

  if (errors.length > 0) {
    throw new Error(`${relativePath} is not valid JSONC: ${JSON.stringify(errors)}`);
  }

  return parsed;
};
