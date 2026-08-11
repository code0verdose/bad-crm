import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';

/**
 * Root of the deliberately broken fixture tree.
 *
 * The fixtures mirror the real monorepo layout (`packages/<pkg>/src/...`) and are linted with the
 * *real* root config: `fixtures/eslint.config.js` re-exports it, and ESLint resolves `files` globs
 * relative to the directory of the config file it loaded. That makes `packages/server/src/**` in
 * the root config match `test/lint/fixtures/packages/server/src/**` here, so these tests exercise
 * the shipped rules and their targeting, not a copy of them.
 */
export const fixturesRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** One ESLint instance per run: the type-aware project service is expensive to build. */
let sharedEslint: ESLint | undefined;

const eslintForFixtures = (): ESLint => {
  sharedEslint ??= new ESLint({ cwd: fixturesRoot, errorOnUnmatchedPattern: true });
  return sharedEslint;
};

/** Repository root, one level above the fixture tree's `packages/`. */
const repoRoot = resolve(fixturesRoot, '..', '..', '..');

/** One instance for the real tree too — same reason as above, and a different `cwd`. */
let repoEslint: ESLint | undefined;

/**
 * The configuration ESLint would apply to a file of the real repository.
 *
 * The fixtures prove a rule fires; they cannot prove it is aimed at anything that ships, because
 * their paths are invented. A `files` glob that matches `packages/client/src/units/task/ui/**` in
 * the fixture tree and nothing under `packages/client/src` — a renamed directory, a `.tsx` the
 * pattern misses — would leave every fixture green and the codebase unguarded.
 */
export const configForRepoFile = async (relativePath: string): Promise<{ rules: object }> => {
  repoEslint ??= new ESLint({ cwd: repoRoot });
  return (await repoEslint.calculateConfigForFile(join(repoRoot, relativePath))) as {
    rules: object;
  };
};

export interface LintOutcome {
  /** Rule ids reported for the file, with fatal parse errors surfacing as `null`. */
  ruleIds: (string | null)[];
  /** Full human-readable messages, used to assert that the guidance points at `rules/*.mdc`. */
  messages: string[];
}

/**
 * Builds typescript-eslint's project service over the fixture tree, so no test case pays for it.
 *
 * The cost is real — seconds, and more when the rest of the root suite occupies the other workers —
 * and it used to land on whichever case ran first. That made a **cold cache** indistinguishable from
 * a broken rule: the same case went red in CI and green on a rerun, and raising its budget from 5 s
 * to 30 s only moved the threshold rather than the cost. Thirty seconds stopped being enough too
 * (CI run 31533848140, three failures out of three) — and because turbo aborts on the first failed
 * task, the client suite behind it stopped running on `main` at all.
 *
 * Charging the warm-up to `beforeAll` fixes the category, not the number: a case that then exceeds
 * its budget has genuinely got slow, which is a thing worth failing over.
 */
export const warmUpFixtureLint = async (): Promise<void> => {
  await eslintForFixtures().lintText('export const warmUp = 1;\n', {
    filePath: join(fixturesRoot, 'packages/shared/src/warm-up.util.ts'),
  });
};

/** Lints a single fixture file, addressed by its path relative to the fixture root. */
export const lintFixture = async (relativePath: string): Promise<LintOutcome> => {
  const [result] = await eslintForFixtures().lintFiles([join(fixturesRoot, relativePath)]);

  if (result === undefined) {
    throw new Error(`ESLint produced no result for fixture ${relativePath}`);
  }

  return {
    ruleIds: result.messages.map((message) => message.ruleId),
    messages: result.messages.map((message) => message.message),
  };
};
