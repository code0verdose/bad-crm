import { defineConfig } from 'vitest/config';

import { ReadsLastSequencer } from './test/repo/reads-last.sequencer.js';

/** Repository-level contract tests: workspace layout, dependency direction, tsconfig contract. */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    /**
     * One process, one module graph, one defined order — all three for the same reason.
     *
     * `test/repo/workspace-layout.test.ts` audits the files this suite reads against the `inputs`
     * of `//#test:repo`; the set it audits is collected at read time by the registry in
     * `test/repo/repo-fixture.util.ts`. Module state cannot cross a worker boundary and does not
     * survive an isolated re-import, so parallel isolated files would leave that audit looking at
     * its own two reads and passing over everything else. The suite is a few seconds of
     * configuration parsing; the parallelism is worth less than the guarantee.
     */
    isolate: false,
    fileParallelism: false,
    sequence: { sequencer: ReadsLastSequencer },
    coverage: {
      enabled: true,
      provider: 'v8',
      /**
       * This suite owns no application code — it asserts repository configuration. What it *does*
       * own is the harness that reads that configuration: if `splitPortMapping` or `environmentOf`
       * is wrong, every compose assertion built on it passes vacuously. Those helpers are the
       * subject here; the deliberately broken sources under `test/lint/fixtures/**` are inputs to
       * a linter, not code that runs.
       *
       * `scripts/**` is measured for the opposite reason: `scripts/check-services.ts` and
       * `scripts/preflight.ts` are real code that belongs to no package, so no package coverage
       * config would ever see them. Everything under `scripts/lib/io/**` is a thin adapter over a
       * socket or `fetch` and is exercised live by `pnpm check:services`, not by a unit test — the
       * decision logic it feeds is what the suite holds to the threshold.
       */
      include: ['test/**/*.util.ts', 'scripts/**/*.ts'],
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
