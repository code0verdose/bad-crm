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
        // Declarations carry no statements to cover, and the OpenAPI schema is generated, not
        // written (`pnpm api:gen`).
        exclude: ['src/**/*.d.ts', 'src/shared/api/schemas/**'],
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
