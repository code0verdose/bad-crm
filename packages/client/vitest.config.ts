import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
    environment: 'node',
    coverage: {
      enabled: true,
      provider: 'v8',
      // Explicit, so that a source file no test imports lowers the percentage instead of being
      // absent from the report altogether.
      include: ['src/**'],
      reporter: ['text-summary', 'json-summary', 'lcovonly'],
      /** `rules/testing.mdc` §7, last row: hooks, schemas and `shared/ui` at 70 / 60. */
      thresholds: {
        lines: 70,
        branches: 60,
      },
    },
  },
});
