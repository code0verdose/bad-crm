import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PACKAGE_DIRS, readJson } from './repo-fixture.util.js';

interface TsConfig {
  extends?: string;
  compilerOptions?: Record<string, unknown> & {
    lib?: string[];
    types?: string[];
    paths?: Record<string, string[]>;
  };
  references?: { path: string }[];
}

/**
 * The client path aliases used to be written out here as a second copy. They are not any more:
 * `packages/client/src/shared/config/fsd-aliases.constant.ts` is the single declaration, and
 * `test/repo/client-aliases.test.ts` checks this `tsconfig.json` and `vite.config.ts` against it.
 * A third list would be a third thing to forget (STORY-004-01).
 */

const tsconfigOf = (dir: string): TsConfig => readJson<TsConfig>(join(dir, 'tsconfig.json'));

describe('tsconfig.base.json', () => {
  const base = (): TsConfig => readJson<TsConfig>('tsconfig.base.json');

  it.each([
    'strict',
    'noUncheckedIndexedAccess',
    'exactOptionalPropertyTypes',
    'noImplicitOverride',
    'noUnusedLocals',
    'noUnusedParameters',
    'noFallthroughCasesInSwitch',
    'isolatedModules',
    'verbatimModuleSyntax',
    'skipLibCheck',
    'forceConsistentCasingInFileNames',
  ])('enables %s', (flag) => {
    expect(base().compilerOptions?.[flag]).toBe(true);
  });

  it('forces module detection so every file is a module', () => {
    expect(base().compilerOptions?.moduleDetection).toBe('force');
  });

  it('targets a modern runtime', () => {
    const target = String(base().compilerOptions?.target);

    expect(Number(target.replace(/^ES/i, ''))).toBeGreaterThanOrEqual(2022);
  });

  it('declares no project-specific paths', () => {
    expect(base().compilerOptions?.paths).toBeUndefined();
  });
});

describe('per-package tsconfig', () => {
  it.each(Object.values(PACKAGE_DIRS))('%s inherits the base config', (dir) => {
    expect(tsconfigOf(dir).extends).toBe('../../tsconfig.base.json');
  });

  it('shared stays isomorphic: no DOM lib and no Node types', () => {
    const options = tsconfigOf(PACKAGE_DIRS.shared).compilerOptions ?? {};

    expect(options.lib?.some((lib) => lib.toLowerCase().startsWith('dom'))).toBe(false);
    expect(options.types).toEqual([]);
  });

  it('shared is a composite project so dependents can reference it', () => {
    const options = tsconfigOf(PACKAGE_DIRS.shared).compilerOptions ?? {};

    expect(options.composite).toBe(true);
    expect(options.declaration).toBe(true);
  });

  it.each([PACKAGE_DIRS.server, PACKAGE_DIRS.client])('%s references shared', (dir) => {
    expect(tsconfigOf(dir).references).toEqual([{ path: '../shared' }]);
  });

  it('e2e references no application sources', () => {
    expect(tsconfigOf(PACKAGE_DIRS.e2e).references ?? []).toEqual([]);
  });

  it('server resolves modules as Node and aliases @/* to src/*', () => {
    const options = tsconfigOf(PACKAGE_DIRS.server).compilerOptions ?? {};

    expect(options.module).toBe('NodeNext');
    expect(options.moduleResolution).toBe('NodeNext');
    expect(options.paths?.['@/*']).toEqual(['./src/*']);
  });

  it('server rewrites path aliases on build with tsc-alias', () => {
    const pkg = readJson<{
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>(join(PACKAGE_DIRS.server, 'package.json'));

    expect(pkg.scripts?.build).toContain('tsc-alias');
    expect(pkg.devDependencies?.['tsc-alias']).toBeTruthy();
  });

  /**
   * `include: ["src/**"]` leaves every suite outside the program, so `tsc` never looks at it. That
   * is not only a missing check: it makes `@ts-expect-error` assertions vacuous. An expectation
   * that is never compiled cannot fail when the error it expects disappears, so a branded id
   * quietly collapsing into `string` would still read as a passing test.
   */
  it.each([PACKAGE_DIRS.shared, PACKAGE_DIRS.server, PACKAGE_DIRS.client])(
    '%s typechecks its test suite in a project of its own',
    (dir) => {
      const testConfig = readJson<TsConfig>(join(dir, 'tsconfig.test.json'));

      expect(testConfig.extends).toBe('./tsconfig.json');
      expect(testConfig.include).toContain('test/**/*.ts');
      expect(testConfig.compilerOptions?.noEmit).toBe(true);
    },
  );

  it.each([PACKAGE_DIRS.shared, PACKAGE_DIRS.server, PACKAGE_DIRS.client])(
    '%s runs that project as part of pnpm typecheck',
    (dir) => {
      const pkg = readJson<{ scripts?: Record<string, string> }>(join(dir, 'package.json'));

      expect(pkg.scripts?.typecheck).toContain('tsconfig.test.json');
    },
  );

  it('client resolves modules as a bundler does, which is what the aliases depend on', () => {
    const options = tsconfigOf(PACKAGE_DIRS.client).compilerOptions ?? {};

    // `Bundler` is what lets `./page.js` in an import resolve to `page.tsx` on disk, the form both
    // Vite and this package's own barrels use. Under `NodeNext` every one of those imports breaks.
    expect(options.moduleResolution).toBe('Bundler');
    expect(options.jsx).toBe('react-jsx');
  });
});
