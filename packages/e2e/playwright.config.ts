import { defineConfig, devices } from '@playwright/test';

/**
 * Configuration of the end-to-end suite.
 *
 * The suite drives a running stack — the client, the API, PostgreSQL, Redis — over HTTP and the
 * browser, and knows nothing of their sources. Everything that depends on where it runs comes from
 * the environment with a default that matches the documented local quickstart, so `pnpm test:e2e`
 * on a laptop needs no arguments and the same file serves CI unchanged.
 *
 * Local runs and CI differ in exactly two places, and both differences are deliberate: retries and
 * the ban on focused specs. See the comments below.
 */

/** True when a continuous integration runner is executing this, false on a developer machine. */
const isCI = (process.env['CI'] ?? '') !== '';

/** Where the browser goes. The client dev server, or a preview/production build behind a proxy. */
const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:5173';

/**
 * Where readiness is asked about — the API, not the client.
 *
 * `/ready` is mounted at the root of the server (`presentation/http/route-registry.factory.ts`) and
 * the client dev server proxies only `/api`, so the probe cannot be reached through `baseURL`.
 */
export const apiURL = process.env['E2E_API_URL'] ?? 'http://localhost:3000';

const numberFrom = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Chromium on every pull request; the full matrix on demand (`E2E_BROWSERS=all`, nightly).
 *
 * Three engines on every push costs roughly three times the wall clock for the defects a second
 * engine finds a few times a year — and a pipeline slow enough to be routinely skipped protects
 * nothing at all.
 */
const projects = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ...((process.env['E2E_BROWSERS'] ?? '') === 'all'
    ? [
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
      ]
    : []),
];

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',

  /**
   * Parallel by default, and that is a property of the suite rather than a speed setting: a
   * scenario that only passes when it runs alone depends on data another scenario left behind, and
   * running them together is what makes that visible on the day it appears.
   */
  fullyParallel: true,

  /** `it.only` left in a spec reduces the suite to one scenario and the run stays green. */
  forbidOnly: isCI,

  /**
   * No retries locally: a test that fails once and passes on the retry is the definition of flaky,
   * and hiding that locally means somebody else discovers it later, in CI, on an unrelated change.
   *
   * Exactly one in CI: a shared runner has neighbours — a cold container, a slow image pull — and
   * a single retry separates «the environment hiccuped» from «this test is unreliable», which
   * Playwright then reports as flaky rather than quietly as a pass.
   */
  retries: isCI ? 1 : 0,

  /** Readiness of the stack is proven before the first scenario, not waited for inside one. */
  globalSetup: './global-setup.ts',

  timeout: numberFrom(process.env['E2E_TEST_TIMEOUT_MS'], 30_000),
  expect: { timeout: numberFrom(process.env['E2E_EXPECT_TIMEOUT_MS'], 5_000) },

  reporter: isCI
    ? [['github'], ['html', { open: 'never' }], ['list']]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL,

    /**
     * Artifacts of failures and nothing else. A trace of a passing run is tens of megabytes nobody
     * will open; a failure without one is a screenshot and a guess.
     */
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects,
});
