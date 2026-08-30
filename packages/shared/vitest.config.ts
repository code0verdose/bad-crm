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
       * **Corrected 2026-08-30: the table has the rows now.** This said `rules/testing.mdc` §7 had no
       * row for `packages/shared`, which was true when the thresholds below were chosen and stopped
       * being true afterwards — §7 today carries two rows for this package, `src/permissions/**` at
       * 100/100 and the package as a whole at 95/90, and both match what is set here.
       *
       * The reasoning that produced them is worth keeping, because it is what the rows encode: what
       * lives here — value objects with invariants, the permission catalogue — is domain code by
       * every other definition in that table, so it is held to the `domain/**` tier;
       * `src/permissions/**` carries the `can()` decision function, a policy in everything but its
       * path, and policies are 100 % lines and branches.
       */
      thresholds: {
        lines: 95,
        branches: 90,
        'src/permissions/**': { lines: 100, branches: 100 },
      },
    },
  },
});
