import { afterEach, describe, expect, it, vi } from 'vitest';

import { PACKAGE_DIRS, listRepoFiles, readJson, readRepoFile } from '../repo/repo-fixture.util.js';

/** Every TypeScript file of the end-to-end package, config and specs alike. */
const e2eSources = (): string[] =>
  listRepoFiles(PACKAGE_DIRS.e2e).filter(
    (path) => path.endsWith('.ts') && !path.includes('/node_modules/'),
  );

/**
 * The contract of the end-to-end harness, asserted before a single scenario exists.
 *
 * Everything here is a property that decides whether a red e2e run means anything. A suite that
 * retries locally hides the flake that a developer could have fixed in the minute it appeared; a
 * suite that waits by sleeping is a suite whose failures depend on the machine it ran on; a suite
 * that keeps videos of successful runs fills the artifact store until somebody turns artifacts off
 * entirely. None of it is visible in a green run, which is why it is pinned here rather than left
 * to review.
 */
interface PlaywrightConfig {
  testDir?: string;
  fullyParallel?: boolean;
  forbidOnly?: boolean;
  retries?: number;
  globalSetup?: string;
  timeout?: number;
  expect?: { timeout?: number };
  use?: {
    baseURL?: string;
    trace?: string;
    screenshot?: string;
    video?: string;
  };
  projects?: { name?: string }[];
}

/**
 * Imports the configuration under a chosen environment.
 *
 * The values that matter most — retries, the browser matrix, the base URL — are decided at import
 * time from the environment, so asserting them means importing twice. `resetModules` is what makes
 * the second import re-evaluate instead of returning the first result from the module cache.
 */
const configWith = async (env: Record<string, string | undefined>): Promise<PlaywrightConfig> => {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

  const module = (await import('../../packages/e2e/playwright.config.js')) as {
    default: PlaywrightConfig;
  };

  return module.default;
};

const projectNames = (config: PlaywrightConfig): string[] =>
  (config.projects ?? []).flatMap((project) => (project.name === undefined ? [] : [project.name]));

const LOCAL = { CI: undefined, E2E_BROWSERS: undefined, E2E_BASE_URL: undefined };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the Playwright configuration', () => {
  it('runs the specs from the directory the layout reserves for them', async () => {
    const config = await configWith(LOCAL);

    expect(config.testDir).toBe('./tests');
  });

  /**
   * Local: no retries. A test that fails once and passes on the retry is the definition of flaky,
   * and hiding it locally means it is discovered by somebody else, later, in CI.
   *
   * CI: exactly one. A shared runner has neighbours — a cold container, a slow pull — and a single
   * retry separates «the environment hiccuped» from «this test is unreliable», which Playwright
   * then reports as flaky rather than as a pass.
   */
  it('never retries locally', async () => {
    expect((await configWith(LOCAL)).retries).toBe(0);
  });

  it('retries once in CI, so a flake is reported as one', async () => {
    expect((await configWith({ ...LOCAL, CI: 'true' })).retries).toBe(1);
  });

  /**
   * `it.only` left in a spec silently reduces the suite to one scenario, and the run stays green.
   * Locally it is a legitimate way to work, so the ban belongs to CI alone.
   */
  it('refuses a focused spec in CI', async () => {
    expect((await configWith({ ...LOCAL, CI: 'true' })).forbidOnly).toBe(true);
    expect((await configWith(LOCAL)).forbidOnly).toBe(false);
  });

  it('runs the specs in parallel, which is what makes them prove independence', async () => {
    expect((await configWith(LOCAL)).fullyParallel).toBe(true);
  });

  describe('the browser matrix', () => {
    /**
     * Chromium on every pull request, the full set on demand. Three browsers on every push buys
     * about three times the wall clock for the defects a second engine finds a few times a year —
     * and a pipeline slow enough to be routinely skipped protects nothing at all.
     */
    it('is chromium alone by default', async () => {
      expect(projectNames(await configWith(LOCAL))).toEqual(['chromium']);
    });

    it('is all three when asked for', async () => {
      const names = projectNames(await configWith({ ...LOCAL, E2E_BROWSERS: 'all' }));

      expect(names).toEqual(['chromium', 'firefox', 'webkit']);
    });
  });

  describe('the base URL', () => {
    it('defaults to the local stack', async () => {
      expect((await configWith(LOCAL)).use?.baseURL).toBe('http://localhost:5173');
    });

    it('is taken from the environment when one is given', async () => {
      const config = await configWith({ ...LOCAL, E2E_BASE_URL: 'http://app.example:8080' });

      expect(config.use?.baseURL).toBe('http://app.example:8080');
    });
  });

  /**
   * Artifacts on failure and only on failure. A trace of a passing run is tens of megabytes nobody
   * will ever open; a failure without one is a screenshot and a guess.
   */
  it('keeps artifacts of failures and nothing else', async () => {
    const { use } = await configWith(LOCAL);

    expect(use?.trace).toBe('on-first-retry');
    expect(use?.screenshot).toBe('only-on-failure');
    expect(use?.video).toBe('retain-on-failure');
  });

  it('waits for readiness before the first scenario', async () => {
    const config = await configWith(LOCAL);

    expect(config.globalSetup).toBeTruthy();
    expect(readRepoFile('packages/e2e/global-setup.ts')).toContain('/ready');
  });
});

describe('the end-to-end package', () => {
  const packageJson = (): { scripts?: Record<string, string>; dependencies?: object } =>
    readJson(`${PACKAGE_DIRS.e2e}/package.json`);

  it.each(['test:e2e', 'test:e2e:ui', 'test:e2e:debug'])('exposes %s', (script) => {
    expect(packageJson().scripts?.[script]).toBeTruthy();
  });

  /**
   * The one property that makes this suite end-to-end rather than a very slow integration test: it
   * may not import the code it is testing. ESLint bans the import; this asserts the package cannot
   * even resolve one, which is the half a lint rule cannot enforce for a transitive path.
   */
  it('depends on no workspace source', () => {
    const declared = JSON.stringify(packageJson().dependencies ?? {});

    expect(declared).not.toContain('@bad-crm/');
  });
});

/**
 * A fixed wait is the one instrument that turns a suite into a coin flip: too short and it fails on
 * a loaded runner, too long and every run pays for the worst case. Playwright's assertions retry
 * until the state arrives, so there is a correct alternative for every use.
 *
 * Scanned here as well as banned by ESLint on purpose — the lint rule covers the identifier in the
 * sources it lints, this covers the whole package including files a future config excludes.
 */
describe('waiting is done by assertion, never by clock', () => {
  it('has no fixed sleep anywhere in the package', () => {
    const offenders = e2eSources().filter((path) => readRepoFile(path).includes('waitForTimeout'));

    expect(offenders).toEqual([]);
  });

  it('CONTROL: the scan reads the package', () => {
    expect(e2eSources().length).toBeGreaterThan(0);
  });
});
