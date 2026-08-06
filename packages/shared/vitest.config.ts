import { availableParallelism } from 'node:os';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /** A share of the machine — see the root `vitest.config.ts` for why, and why it is derived. */
    maxWorkers: Math.max(1, Math.floor(availableParallelism() / 4)),
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      enabled: true,
      provider: 'v8',
      // Explicit, so that a source file no test imports lowers the percentage instead of being
      // absent from the report altogether.
      include: ['src/**'],
      reporter: ['text-summary', 'json-summary', 'lcovonly'],
      /**
       * `rules/testing.mdc` §7 has no row for `packages/shared` — the table was written before the
       * package was filled. What lives here (value objects with invariants, the permission
       * catalogue) is domain code by every other definition in that table, so it is held to the
       * `domain/**` tier. `src/permissions/**` carries the `can()` decision function, a policy in
       * everything but its path, and policies are 100 % lines and branches (§7, row 1).
       */
      thresholds: {
        lines: 95,
        branches: 90,
        'src/permissions/**': { lines: 100, branches: 100 },
      },
    },
  },
});
