import { describe, expect, it } from 'vitest';

import clientConfig from '../../packages/client/vitest.config.js';
import serverConfig from '../../packages/server/vitest.config.js';
import sharedConfig from '../../packages/shared/vitest.config.js';
import rootConfig from '../../vitest.config.js';
import { PACKAGE_DIRS, readJson } from './repo-fixture.util.js';

interface CoverageThreshold {
  lines?: number;
  branches?: number;
  functions?: number;
  statements?: number;
}

interface CoverageOptions {
  provider?: string;
  enabled?: boolean;
  include?: string[];
  reportsDirectory?: string;
  thresholds?: CoverageThreshold & Record<string, CoverageThreshold | number | boolean>;
}

interface VitestConfig {
  test?: { coverage?: CoverageOptions };
}

const coverageOf = (config: unknown): CoverageOptions =>
  (config as VitestConfig).test?.coverage ?? {};

const CONFIGS: Record<string, unknown> = {
  root: rootConfig,
  shared: sharedConfig,
  server: serverConfig,
  client: clientConfig,
};

/**
 * `turbo.json` has declared `outputs: ["coverage/**"]` on `test` since the pipeline was written,
 * but no package carried a coverage provider — so the directory never appeared, turbo warned
 * "no output files found" on every run, and the thresholds of `rules/testing.mdc` §7 were a
 * document rather than a gate. These tests fail if the provider or the thresholds go missing
 * again.
 */
describe('coverage is measured, not just declared', () => {
  it.each(Object.keys(CONFIGS))('%s enables the v8 coverage provider', (name) => {
    const coverage = coverageOf(CONFIGS[name]);

    expect(coverage.enabled).toBe(true);
    expect(coverage.provider).toBe('v8');
  });

  it.each(['shared', 'server', 'client'])('%s measures its whole src tree', (name) => {
    // Without an explicit `include`, a source file that no test imports is simply absent from the
    // report, and an untested module raises the percentage instead of lowering it.
    expect(coverageOf(CONFIGS[name]).include).toEqual(['src/**']);
  });

  it.each(Object.values(PACKAGE_DIRS).filter((dir) => dir !== PACKAGE_DIRS.e2e))(
    '%s declares the coverage provider as a devDependency',
    (dir) => {
      const pkg = readJson<{ devDependencies?: Record<string, string> }>(`${dir}/package.json`);

      expect(pkg.devDependencies?.['@vitest/coverage-v8']).toBeTruthy();
    },
  );
});

/** The numbers come from `rules/testing.mdc` §7, not from what the current suite happens to hit. */
describe('thresholds match rules/testing.mdc §7', () => {
  it('holds packages/server to 85 % lines and 80 % branches', () => {
    const thresholds = coverageOf(serverConfig).thresholds ?? {};

    expect(thresholds.lines).toBe(85);
    expect(thresholds.branches).toBe(80);
  });

  it('holds server infrastructure and presentation to 75 % / 70 %', () => {
    const thresholds = coverageOf(serverConfig).thresholds ?? {};

    for (const glob of ['src/infrastructure/**', 'src/presentation/**']) {
      expect(thresholds[glob], glob).toEqual({ lines: 75, branches: 70 });
    }
  });

  it('holds server domain and application to their stricter tiers', () => {
    const thresholds = coverageOf(serverConfig).thresholds ?? {};

    expect(thresholds['src/domain/**']).toEqual({ lines: 95, branches: 90 });
    expect(thresholds['src/domain/**/access/*.policy.ts']).toEqual({ lines: 100, branches: 100 });
    expect(thresholds['src/application/**']).toEqual({ lines: 90, branches: 85 });
  });

  it('holds packages/client to 70 % lines and 60 % branches', () => {
    const thresholds = coverageOf(clientConfig).thresholds ?? {};

    expect(thresholds.lines).toBe(70);
    expect(thresholds.branches).toBe(60);
  });

  it('holds packages/shared to the domain tier, and its permission code to 100 %', () => {
    const thresholds = coverageOf(sharedConfig).thresholds ?? {};

    expect(thresholds.lines).toBe(95);
    expect(thresholds.branches).toBe(90);
    expect(thresholds['src/permissions/**']).toEqual({ lines: 100, branches: 100 });
  });

  it('never lets a threshold be rewritten by a passing run', () => {
    for (const name of Object.keys(CONFIGS)) {
      expect(coverageOf(CONFIGS[name]).thresholds?.autoUpdate, name).not.toBe(true);
    }
  });
});
