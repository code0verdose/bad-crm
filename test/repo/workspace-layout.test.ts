import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { PACKAGE_NAMES, PACKAGE_DIRS, readJson, repoRoot } from './repo-fixture.util.js';

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
    const raw = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
    const workspace = parseYaml(raw) as { packages?: string[] };

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

  it('requires Node 22', () => {
    const node = rootPackageJson().engines?.node;

    expect(node).toBeDefined();
    expect(node).toContain('22');
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
   * Every file the root suite reads has to appear in `inputs`, in some form. The list below is
   * derived by hand from the `readFileSync`/`import` calls under `test/**`; it is asserted here so
   * that adding a read without extending `inputs` fails loudly instead of silently caching.
   */
  it('covers every repository file the root suite reads', () => {
    const inputs = turbo().tasks['//#test:repo']?.inputs ?? [];
    const globalDeps =
      readJson<{ globalDependencies?: string[] }>('turbo.json').globalDependencies ?? [];
    const hashed = [...inputs, ...globalDeps];

    const readByTheSuite = [
      'test/**',
      'package.json',
      'pnpm-workspace.yaml',
      'turbo.json',
      'tsconfig.base.json',
      'docker-compose.yml',
      '.env.example',
      '.gitignore',
      '.nvmrc',
      'packages/*/package.json',
      'packages/*/tsconfig.json',
      'packages/*/src/**',
      // `test/infra/compose.test.ts` asserts the RLS invariants of the bootstrap SQL — the only
      // automated guard of tenant isolation in the repository right now. Leaving it out of `inputs`
      // means a change that drops NOBYPASSRLS from app_user is served from cache as FULL TURBO.
      'packages/*/prisma/**',
      // `test/repo/coverage-contract.test.ts` imports every vitest config: without these, the
      // coverage thresholds of rules/testing.mdc §7 can be lowered behind a cached pass.
      // `test/repo/tsconfig-contract.test.ts` reads these: without them a change dropping
      // `test/**` from `include` — which makes every @ts-expect-error in the package vacuous —
      // is served from cache as a pass.
      'packages/*/tsconfig.test.json',
      // `test/repo/runbook-restore.test.ts` reads both: the restore runbook is an executable
      // procedure, and each of its three past defects ended in an empty or unusable database.
      'docs/runbooks/backup-restore.md',
      'docs/security/rls-design.md',
      'packages/*/vitest.config.ts',
      'vitest.config.ts',
    ];

    expect(readByTheSuite.filter((path) => !hashed.includes(path))).toEqual([]);
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
