import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      enabled: true,
      provider: 'v8',
      // Explicit, so that a source file no test imports lowers the percentage instead of being
      // absent from the report altogether.
      include: ['src/**'],
      reporter: ['text-summary', 'json-summary', 'lcovonly'],
      /**
       * `rules/testing.mdc` §7, verbatim: the whole package at 85 / 80, with the per-layer tiers
       * on top. The layer globs are declared before their directories exist — a threshold added
       * on the day the first use-case lands is a threshold nobody adds.
       */
      thresholds: {
        lines: 85,
        branches: 80,
        'src/domain/**': { lines: 95, branches: 90 },
        'src/domain/**/access/*.policy.ts': { lines: 100, branches: 100 },
        'src/application/**': { lines: 90, branches: 85 },
        'src/infrastructure/**': { lines: 75, branches: 70 },
        'src/presentation/**': { lines: 75, branches: 70 },
      },
    },
  },
});
