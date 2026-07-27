import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PACKAGE_DIRS, readJson, readRepoFile } from './repo-fixture.util.js';

interface PackageJson {
  engines?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

const rootPackageJson = (): PackageJson => readJson<PackageJson>('package.json');
const packageJsonOf = (dir: string): PackageJson =>
  readJson<PackageJson>(join(dir, 'package.json'));

/** Every place in the workspace that declares a `typescript` version, keyed by the file it lives in. */
const declaredTypescriptVersions = (): Record<string, string> => {
  const entries: Record<string, string> = {};
  const collect = (label: string, pkg: PackageJson): void => {
    const version = pkg.devDependencies?.typescript ?? pkg.dependencies?.typescript;
    if (version !== undefined) entries[label] = version;
  };

  collect('package.json', rootPackageJson());
  for (const dir of Object.values(PACKAGE_DIRS)) {
    collect(`${dir}/package.json`, packageJsonOf(dir));
  }

  return entries;
};

/**
 * ADR-0022: one TypeScript version for the whole workspace. Two versions mean the compiler that
 * typechecks the code is not the compiler that builds it, and type-aware ESLint rules silently
 * degrade to `any` when their peer resolves elsewhere.
 */
describe('TypeScript version policy (ADR-0022)', () => {
  it('declares typescript in the root and in every package', () => {
    expect(Object.keys(declaredTypescriptVersions()).sort()).toEqual(
      ['package.json', ...Object.values(PACKAGE_DIRS).map((dir) => `${dir}/package.json`)].sort(),
    );
  });

  it('uses exactly one typescript version across the workspace', () => {
    const versions = declaredTypescriptVersions();

    expect(new Set(Object.values(versions)).size, JSON.stringify(versions, null, 2)).toBe(1);
  });

  it('pins that version exactly, without a range operator', () => {
    for (const [file, version] of Object.entries(declaredTypescriptVersions())) {
      expect(version, file).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('stays on the 5.x line typescript-eslint supports', () => {
    for (const [file, version] of Object.entries(declaredTypescriptVersions())) {
      expect(version, file).toMatch(/^5\./);
    }
  });
});

/**
 * The Node floor is not cosmetic: `lint-staged` and `@commitlint/cli` refuse to run below it, and
 * a mismatch between `.nvmrc` and `engines` sends contributors to a version the hooks reject.
 */
describe('Node version floor', () => {
  const engineRange = (): string => {
    const node = rootPackageJson().engines?.node;
    expect(node).toBeDefined();
    return node as string;
  };

  const floorOf = (range: string): [number, number, number] => {
    const match = /^>=(\d+)\.(\d+)\.(\d+)/.exec(range);
    expect(match, `engines.node must start with an explicit floor, got ${range}`).not.toBeNull();
    const [, major, minor, patch] = match as RegExpExecArray;
    return [Number(major), Number(minor), Number(patch)];
  };

  it('requires at least the Node version the git hooks need', () => {
    // Raised from 22.22.1 by jsdom@30, which declares `^22.22.2 || ^24.15.0 || >=26.0.0`. The
    // floor is whatever the strictest dependency demands, and CI is where that is discovered:
    // locally nvm resolved `22` to 22.22.2, so `.nvmrc` pinned a version nobody was running.
    expect(floorOf(engineRange())).toEqual([22, 22, 2]);
  });

  /**
   * Replaces an assertion that required `<23`.
   *
   * That ceiling was never measured — and it silently disabled the project's dependency updates:
   * Dependabot runs its npm updater on Node 24, saw a range it could not satisfy, and answered
   * every package with `tool_version_not_supported`. No security update could open a pull request.
   * The suite was then run on Node 24 in full and passed; the only failure was this range being
   * enforced by pnpm. `.nvmrc` still pins what contributors and CI use — a ceiling here would be a
   * claim about code we have, not about tooling we run.
   */
  it('declares no upper bound, so tooling on a newer Node can still resolve the workspace', () => {
    expect(engineRange()).not.toMatch(/</);
  });

  it('matches .nvmrc', () => {
    const nvmrc = readRepoFile('.nvmrc').trim();
    const [major, minor, patch] = floorOf(engineRange());

    expect(nvmrc).toBe(`${major}.${minor}.${patch}`);
  });
});
