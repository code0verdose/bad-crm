import { describe, expect, it } from 'vitest';

import { listRepoFiles, readRepoFile } from './repo-fixture.util.js';

/**
 * Every directory of integration tests is claimed by a project that runs it.
 *
 * Written after both `test/integration/mail` and `test/integration/rate-limit` landed complete,
 * green under a hand-made config, and matched by **no** `include` glob in the repository: not
 * `vitest.config.ts`, which takes `test/integration/http/**`, and not the container config, which
 * took `test/integration/db/**`. `pnpm test` and `pnpm test:integration` both reported success over
 * suites neither of them ran.
 *
 * That failure has no signal of its own. A test that is never executed does not fail, does not
 * appear in a count anybody compares, and does not lower coverage — the sources it exercises are
 * simply covered by nothing, which looks the same as sources nobody wrote a test for. The only
 * moment it becomes visible is when someone reads two config files side by side and notices a
 * directory in neither.
 *
 * So the assertion is on the directory listing rather than on the globs: a directory added tomorrow
 * has to be claimed on the day it appears, not on the day somebody happens to compare the configs.
 */

const INTEGRATION_ROOT = 'packages/server/test/integration';

/** Directories that hold no test of their own — fixtures and container bootstrap. */
const SUPPORT_DIRECTORIES = new Set(['setup']);

/** The first path segment under `test/integration` of every file that holds tests there. */
const integrationDirectories = (): string[] =>
  [
    ...new Set(
      listRepoFiles(INTEGRATION_ROOT)
        .filter((path) => path.endsWith('.test.ts'))
        .map((path) => path.slice(`${INTEGRATION_ROOT}/`.length).split('/')[0] ?? '')
        .filter((name) => name !== '' && !SUPPORT_DIRECTORIES.has(name)),
    ),
  ].sort();

/**
 * The directory names named by the `include` globs of a config, however they are spelled: as a
 * plain segment (`test/integration/db/**`) or as a brace group (`test/integration/{mail,rate}/**`).
 */
const claimedDirectories = (configSource: string): Set<string> => {
  const claimed = new Set<string>();

  for (const [, group] of configSource.matchAll(/test\/integration\/([^/'"]+)\//g)) {
    for (const name of (group ?? '').replace(/[{}]/g, '').split(',')) {
      if (name !== '') claimed.add(name.trim());
    }
  }

  return claimed;
};

describe('integration suites are claimed by a project', () => {
  it('runs every directory under test/integration', () => {
    const claimed = new Set([
      ...claimedDirectories(readRepoFile('packages/server/vitest.integration.config.ts')),
      ...claimedDirectories(readRepoFile('packages/server/vitest.config.ts')),
    ]);

    const unclaimed = integrationDirectories().filter((name) => !claimed.has(name));

    expect(
      unclaimed,
      `no vitest project includes packages/server/test/integration/${unclaimed.join(', ')} — ` +
        'the suites there are never executed, and neither command reports it',
    ).toEqual([]);
  });

  /**
   * The positive control. Without it the assertion above passes just as well when the extractor
   * silently stops finding anything — an empty set of directories has no unclaimed member either.
   */
  it('finds the directories it is comparing', () => {
    const directories = integrationDirectories();

    expect(directories.length).toBeGreaterThan(1);
    expect(directories).toContain('db');
  });

  it('reads a claim written as a brace group, not only as a plain segment', () => {
    expect(
      claimedDirectories("include: ['test/integration/{mail,rate-limit}/**/*.test.ts']"),
    ).toEqual(new Set(['mail', 'rate-limit']));
  });
});
