import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config.js';

/**
 * The runner inherits the application configuration so that a suite can never resolve `@/…`
 * differently from the bundler.
 *
 * Coverage is measured over the logic, not over the choreography: `shared/lib` and `app/i18n` are
 * where a wrong number or a missing key silently changes behaviour, while a section component is a
 * sequence of scroll-driven transforms whose correctness is a screenshot, not a percentage. The
 * sections still carry smoke tests — they just do not set the gate.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
      environment: 'jsdom',
      /* Same reason as `packages/client`: rendering the whole page and running axe over it takes a
         few seconds on a machine that is also running three other package suites, and the default
         5 s budget turns a busy CI runner into a red build. */
      testTimeout: 20_000,
      setupFiles: ['./test/setup/testing-library.setup.ts'],
      coverage: {
        enabled: true,
        provider: 'v8',
        /* The logic, not the scenery. The sections are scroll-linked scenes whose correctness is a
           screenshot rather than a percentage; these five are the parts where a bug is silent —
           the dictionaries, the routing, consent, the scroll and reduced-motion hooks, and the two
           interactive pieces (the cookie banner and the feedback form). */
        include: [
          'src/shared/lib/**',
          'src/app/i18n/**',
          'src/widgets/cookie-banner.widget.tsx',
          'src/sections/cta/feedback-form.component.tsx',
          'src/pages/**',
        ],
        exclude: ['src/**/*.d.ts'],
        reporter: ['text-summary', 'json-summary', 'lcovonly'],
        thresholds: {
          lines: 80,
          branches: 70,
        },
      },
    },
  }),
);
