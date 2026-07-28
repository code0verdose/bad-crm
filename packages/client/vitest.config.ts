import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config.js';

/**
 * The runner inherits the application configuration instead of restating it.
 *
 * The alias table is the reason: a suite that resolves `@shared` differently from the bundler is a
 * suite that passes over code the browser never runs. Merging the Vite config makes divergence
 * impossible here — `test/repo/client-aliases.test.ts` covers the other two consumers,
 * `tsconfig.json` and `vite.config.ts` itself.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
      // Component tests render into a DOM. It is the runner's DOM, not a browser: anything that
      // depends on real layout or on a real navigation belongs in Playwright instead.
      environment: 'jsdom',
      setupFiles: ['./test/setup/testing-library.setup.ts'],
      coverage: {
        enabled: true,
        provider: 'v8',
        // Explicit, so that a source file no test imports lowers the percentage instead of being
        // absent from the report altogether.
        include: ['src/**'],
        /**
         * Declarations carry no statements to cover, and the OpenAPI schema is generated, not
         * written (`pnpm api:gen`). Two more entries arrived with the router (STORY-004-05):
         *
         * - `route-tree.gen.ts` is rewritten by `@tanstack/router-plugin` on every build;
         * - `routes/**` is measured as 50 % whatever the suite does. Measured, not assumed: the
         *   uncovered line is the closing `});` of the `createFileRoute(...)({ … })` call in every
         *   one of them, with and without `autoCodeSplitting`, while the object it builds is
         *   demonstrably live — the guards run, the schemas validate and the components render in
         *   `test/routes/navigation.test.tsx`. Keeping them in would mean a permanent 1.4 % deficit
         *   that no test can close, which is how a coverage gate stops being believed. What makes
         *   the exclusion safe is the rule that route files hold wiring only
         *   (`rules/frontend-fsd.mdc` rule 10) — the wiring itself is asserted through navigation.
         */
        exclude: [
          'src/**/*.d.ts',
          'src/shared/api/schemas/**',
          'src/app/route-tree.gen.ts',
          'src/app/routes/**',
        ],
        reporter: ['text-summary', 'json-summary', 'lcovonly'],
        /** `rules/testing.mdc` §7, last row: hooks, schemas and `shared/ui` at 70 / 60. */
        thresholds: {
          lines: 70,
          branches: 60,
        },
      },
    },
  }),
);
