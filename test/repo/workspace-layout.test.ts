import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import rootVitestConfig from '../../vitest.config.js';
import { importedRepoFiles, matchesGlob, unhashedReads } from './hashed-inputs.util.js';
import { ReadsLastSequencer } from './reads-last.sequencer.js';
import {
  PACKAGE_NAMES,
  PACKAGE_DIRS,
  readJson,
  readRepoFile,
  recordedReads,
} from './repo-fixture.util.js';

interface PackageJson {
  name?: string;
  private?: boolean;
  type?: string;
  license?: string;
  packageManager?: string;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface TurboTask {
  dependsOn?: string[];
  outputs?: string[];
  cache?: boolean;
  persistent?: boolean;
  inputs?: string[];
}

const rootPackageJson = (): PackageJson => readJson<PackageJson>('package.json');
const packageJsonOf = (dir: string): PackageJson =>
  readJson<PackageJson>(join(dir, 'package.json'));

/** Internal workspace dependencies of a package, regardless of dependency kind. */
const internalDepsOf = (dir: string): string[] => {
  const pkg = packageJsonOf(dir);
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].filter(
    (name) => name.startsWith('@bad-crm/'),
  );
};

describe('pnpm workspace', () => {
  it('declares packages/* as the only workspace glob', () => {
    const workspace = parseYaml(readRepoFile('pnpm-workspace.yaml')) as { packages?: string[] };

    expect(workspace.packages).toEqual(['packages/*']);
  });

  it.each(Object.entries(PACKAGE_DIRS))('contains the %s package', (name, dir) => {
    expect(packageJsonOf(dir).name).toBe(PACKAGE_NAMES[name as keyof typeof PACKAGE_NAMES]);
  });

  it.each(Object.values(PACKAGE_DIRS))('%s is private and ESM', (dir) => {
    const pkg = packageJsonOf(dir);

    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
  });
});

describe('dependency direction', () => {
  it('shared depends on no other workspace package', () => {
    expect(internalDepsOf(PACKAGE_DIRS.shared)).toEqual([]);
  });

  it.each([PACKAGE_DIRS.server, PACKAGE_DIRS.client])('%s depends on shared only', (dir) => {
    expect(internalDepsOf(dir)).toEqual([PACKAGE_NAMES.shared]);
    expect(packageJsonOf(dir).dependencies?.[PACKAGE_NAMES.shared]).toBe('workspace:*');
  });

  it('e2e depends on no workspace sources', () => {
    expect(internalDepsOf(PACKAGE_DIRS.e2e)).toEqual([]);
  });
});

describe('root package.json', () => {
  it('is a private, AGPL-licensed workspace root named bad-crm', () => {
    const pkg = rootPackageJson();

    expect(pkg.name).toBe('bad-crm');
    expect(pkg.private).toBe(true);
    expect(pkg.license).toBe('AGPL-3.0-or-later');
  });

  it('pins the package manager for Corepack', () => {
    expect(rootPackageJson().packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  /**
   * A floor, and deliberately no ceiling.
   *
   * The floor is real: `lint-staged` and `@commitlint/cli` both refuse to install below 22.22.1.
   * The ceiling was not — it was written by hand and never tested, and it cost the project its
   * dependency updates: Dependabot runs its npm updater on Node 24 and answered every package with
   * `tool_version_not_supported`, so no security update could ever open a pull request. The suite
   * was then run on Node 24 and passed in full; the only thing that failed was this range checking
   * itself. A ceiling belongs here when a version is known to break the code, not before.
   */
  it('declares a Node floor and no ceiling, so tooling on a newer Node can still run', () => {
    const node = rootPackageJson().engines?.node;

    expect(node).toBe('>=22.22.1');
    expect(node, 'an upper bound blocks Dependabot; see the compat job in ci.yml').not.toMatch(/</);
  });

  it.each([
    'dev',
    'build',
    'typecheck',
    'lint',
    'test',
    'test:integration',
    'test:e2e',
    'db:migrate',
    'db:seed',
    'api:gen',
    'docker:up',
  ])('exposes the %s command', (script) => {
    expect(rootPackageJson().scripts?.[script]).toBeTruthy();
  });

  it.each([
    'dev',
    'build',
    'typecheck',
    'lint',
    'test',
    'test:integration',
    'test:e2e',
    'db:migrate',
    'db:seed',
    'api:gen',
  ])('delegates %s to turbo instead of a single package', (script) => {
    expect(rootPackageJson().scripts?.[script]).toContain('turbo run');
  });
});

describe('turbo pipeline', () => {
  const turbo = (): { tasks: Record<string, TurboTask> } =>
    readJson<{ tasks: Record<string, TurboTask> }>('turbo.json');

  it.each(['build', 'typecheck', 'lint', 'test', 'test:e2e', 'db:migrate', 'dev'])(
    'declares the %s task',
    (task) => {
      expect(turbo().tasks[task]).toBeDefined();
    },
  );

  it('keeps typecheck and build as separate tasks', () => {
    const tasks = turbo().tasks;

    expect(tasks.build?.outputs).toContain('dist/**');
    expect(tasks.typecheck?.outputs ?? []).not.toContain('dist/**');
  });

  it.each(['build', 'typecheck', 'test'])('builds upstream packages before %s', (task) => {
    expect(turbo().tasks[task]?.dependsOn).toContain('^build');
  });

  it('runs dev as a persistent, uncached task', () => {
    const dev = turbo().tasks.dev;

    expect(dev?.persistent).toBe(true);
    expect(dev?.cache).toBe(false);
  });

  it.each(['test:e2e', 'db:migrate', 'db:seed'])(
    'never caches %s, because it depends on external state',
    (task) => {
      expect(turbo().tasks[task]?.cache).toBe(false);
    },
  );

  /**
   * `api:gen` regenerates a file that is committed, and CI verifies it by regenerating and
   * requiring an empty diff — which means the value of that gate is exactly the correctness of
   * this task's cache key. The entry that used to be missing is `$TURBO_DEFAULT$`: with only the
   * specification listed, every other file of the package was outside the hash, so a change to how
   * generation works was served from cache and the committed types were "verified" against a run
   * that never happened.
   */
  describe('the codegen task hashes everything it reads', () => {
    const apiGenInputs = (): string[] => turbo().tasks['api:gen']?.inputs ?? [];

    it('hashes the package own files', () => {
      expect(apiGenInputs()).toContain('$TURBO_DEFAULT$');
    });

    it('hashes the specification, which lives outside the package', () => {
      expect(apiGenInputs()).toContain('$TURBO_ROOT$/docs/api/openapi.yaml');
    });

    it('writes the generated types where the client keeps them', () => {
      expect(turbo().tasks['api:gen']?.outputs).toEqual(['src/shared/api/schemas/**']);
    });

    it('is backed by a package script, so `turbo run api:gen` has something to run', () => {
      const scripts = packageJsonOf(PACKAGE_DIRS.client).scripts ?? {};

      expect(scripts['api:gen']).toContain('openapi-typescript');
      expect(scripts['api:gen']).toContain('docs/api/openapi.yaml');
    });
  });

  it('invalidates the repository contract tests on config changes', () => {
    const inputs = turbo().tasks['//#test:repo']?.inputs ?? [];

    expect(inputs).toContain('turbo.json');
    expect(inputs).toContain('packages/*/package.json');
  });

  /**
   * An `inputs` array is an allow-list: whatever it omits cannot invalidate the cache, and the
   * task then reports a cached PASS over a file it never re-read. `//#test:repo` is the only gate
   * that proves `.env.example` still matches the two env schemas, and those schemas live under
   * the `src` tree of each package — so omitting them turns "someone added a variable to the
   * schema and forgot the template" into a green build and a self-host install that dies on a
   * variable the operator was never told to set.
   */
  it.each([
    ['packages/*/src/**', 'the env schemas the sync test imports'],
    ['.gitignore', 'the .env-is-never-committed assertion'],
  ])('hashes %s, because the suite reads it for %s', (input) => {
    expect(turbo().tasks['//#test:repo']?.inputs ?? []).toContain(input);
  });

  /**
   * Every file the root suite reads has to appear in `inputs`, in some form.
   *
   * This used to be a hand-written list of paths, and within one epic it fell behind the code three
   * times — `packages/{pkg}/prisma/**`, then `packages/{pkg}/tsconfig.test.json`, then the two
   * documents `runbook-restore.test.ts` reads. Each gap meant a cached PASS over a file the task
   * had never re-read — the exact failure this test exists to prevent. What it actually checked was
   * whether somebody had remembered to append a line, not whether the suite reads what turbo
   * hashes.
   *
   * So the set is no longer written down. `readRepoFile`/`readJson` register every path they open
   * (`repo-fixture.util.ts`), `importedRepoFiles()` recovers the sources that arrive through
   * `import` instead of through a read, and this test compares the union against the `inputs`
   * globs. A read that nothing hashes fails here under its own name.
   */
  const hashedInputs = (): string[] => [
    ...(turbo().tasks['//#test:repo']?.inputs ?? []),
    ...(readJson<{ globalDependencies?: string[] }>('turbo.json').globalDependencies ?? []),
  ];

  /**
   * The registry is module state, so it only spans test files while they share one module graph and
   * while this file runs last: `isolate: false`, `fileParallelism: false` and `ReadsLastSequencer`
   * in `vitest.config.ts`. Undo any of the three and the audit below still passes — over its own
   * handful of reads, having seen nothing else. `poolOptions.forks.singleFork` looked like it would
   * do the job and did not, so the settings are asserted twice: once as configuration, and once as
   * the observable effect of that configuration.
   */
  it.each([
    ['isolate', rootVitestConfig.test?.isolate],
    ['fileParallelism', rootVitestConfig.test?.fileParallelism],
  ])('keeps %s off, so the read registry spans the whole suite', (_option, value) => {
    expect(value).toBe(false);
  });

  it('runs this file last, after every suite that fills the registry', () => {
    expect(rootVitestConfig.test?.sequence?.sequencer).toBe(ReadsLastSequencer);
  });

  /**
   * The effect: paths belonging to three other suites, which this file never opens itself. They are
   * only present when the whole suite ran — a filtered run such as `vitest run workspace-layout`
   * cannot satisfy them, and is not how `//#test:repo` invokes this suite.
   */
  it.each([
    ['docker-compose.yml', 'test/infra'],
    ['.env.example', 'test/env'],
    ['docs/runbooks/backup-restore.md', 'test/repo/runbook-restore.test.ts'],
    ['packages/server/tsconfig.test.json', 'test/repo/tsconfig-contract.test.ts'],
  ])('sees %s, read by %s and not by this file', (path, reader) => {
    expect(recordedReads(), `${reader} did not share its reads with this file`).toContain(path);
  });

  it('covers every repository file the root suite reads', () => {
    // Recovers the `import`-only dependencies into the registry before it is read out, so that the
    // union below is complete regardless of the order of these two calls' side effects.
    importedRepoFiles();

    const uncovered = unhashedReads(hashedInputs(), recordedReads());

    expect(uncovered, `not hashed by //#test:repo inputs: ${uncovered.join(', ')}`).toEqual([]);
  });

  /** The glob semantics the audit above depends on, including the case that silently over-covers. */
  describe('input globs are expanded, not compared as strings', () => {
    it.each([
      ['packages/*/src/**', 'packages/server/src/infrastructure/bootstrap/env.schema.ts'],
      ['packages/*/src/**', 'packages/client/src/env.ts'],
      ['packages/*/package.json', 'packages/e2e/package.json'],
      ['test/**', 'test/repo/workspace-layout.test.ts'],
      ['turbo.json', 'turbo.json'],
    ])('%s covers %s', (pattern, path) => {
      expect(matchesGlob(pattern, path)).toBe(true);
    });

    it.each([
      ['packages/*/tsconfig.json', 'packages/server/tsconfig.test.json'],
      ['packages/*/package.json', 'packages/client/prisma/package.json'],
      ['packages/*/src/**', 'packages/server/prisma/schema.prisma'],
      ['test/**', 'testing/foo.ts'],
    ])('%s does not cover %s', (pattern, path) => {
      expect(matchesGlob(pattern, path)).toBe(false);
    });
  });
});

/**
 * `turbo run lint` only reaches packages that declare a `lint` script, so `test/**` — the
 * repository-contract suite, roughly half of all tests — was linted by nothing. That silently
 * disabled `vitest/no-focused-tests` exactly where a stray `describe.only` is most expensive: one
 * of them collapses the suite to a handful of specs while the gate stays green.
 */
describe('repository-level tasks', () => {
  const turbo = (): { tasks: Record<string, TurboTask> } =>
    readJson<{ tasks: Record<string, TurboTask> }>('turbo.json');

  it.each(['test:repo', 'lint:repo'])('declares the //#%s root task', (task) => {
    expect(turbo().tasks[`//#${task}`]).toBeDefined();
  });

  /**
   * The runtime read registry can only see files the vitest process opens. A root task whose
   * command is `tsc -p tsconfig.scripts.json && vitest run` reads a second file before vitest
   * starts, and nothing else would notice it missing from `inputs` — the task would report a
   * cached pass over a typecheck project that had been narrowed to nothing.
   */
  it('hashes every project file named on a root task command line', () => {
    const scripts = rootPackageJson().scripts ?? {};
    const named = Object.entries(scripts)
      .filter(([name]) => name.endsWith(':repo'))
      .flatMap(([, command]) => [...command.matchAll(/(?:-p|--project)\s+(\S+)/g)])
      .map((match) => match[1] as string);

    expect(named.length).toBeGreaterThan(0);

    const hashed = new Set([
      ...(turbo().tasks['//#test:repo']?.inputs ?? []),
      ...(readJson<{ globalDependencies?: string[] }>('turbo.json').globalDependencies ?? []),
    ]);

    expect(named.filter((path) => !hashed.has(path))).toEqual([]);
  });

  it.each(['test:repo', 'lint:repo'])('backs //#%s with a root script', (script) => {
    expect(rootPackageJson().scripts?.[script]).toBeTruthy();
  });

  it('lints the root-owned files with the same zero-warning budget as the packages', () => {
    const script = rootPackageJson().scripts?.['lint:repo'] ?? '';

    expect(script).toContain('eslint');
    expect(script).toContain('--max-warnings 0');
  });

  it.each([
    ['test', '//#test:repo'],
    ['lint', '//#lint:repo'],
  ])('makes pnpm %s run %s', (task, rootTask) => {
    expect(turbo().tasks[task]?.dependsOn).toContain(rootTask);
  });
});
