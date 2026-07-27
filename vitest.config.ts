import { defineConfig } from 'vitest/config';

/** Repository-level contract tests: workspace layout, dependency direction, tsconfig contract. */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      enabled: true,
      provider: 'v8',
      /**
       * This suite owns no application code — it asserts repository configuration. What it *does*
       * own is the harness that reads that configuration: if `splitPortMapping` or `environmentOf`
       * is wrong, every compose assertion built on it passes vacuously. Those helpers are the
       * subject here; the deliberately broken sources under `test/lint/fixtures/**` are inputs to
       * a linter, not code that runs.
       */
      include: ['test/**/*.util.ts'],
      exclude: ['test/lint/fixtures/**'],
      reporter: ['text-summary', 'json-summary', 'lcovonly'],
      /** Harness code, held to the `infrastructure/**` tier of `rules/testing.mdc` §7. */
      thresholds: {
        lines: 75,
        branches: 70,
      },
    },
  },
});
