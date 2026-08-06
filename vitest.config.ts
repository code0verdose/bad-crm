import { availableParallelism } from 'node:os';

import { defineConfig } from 'vitest/config';

import { ReadsLastSequencer } from './test/repo/reads-last.sequencer.js';

/** Repository-level contract tests: workspace layout, dependency direction, tsconfig contract. */
export default defineConfig({
  test: {
    /**
     * A share of the machine, not all of it — **the reference copy of this rule**; the three package
     * configs carry the same expression and point here.
     *
     * `turbo run test` starts four vitest projects at once and each one defaults to a worker per
     * core. On a ten-core machine that is forty processes, every one of them transforming, rendering
     * and waiting — and what it looks like is not «slow»: it is a test that times out at twenty
     * seconds while doing nothing but queuing, in a different file on every run.
     *
     * Derived rather than fixed, because a fixed number is a statement about one machine: three per
     * project is right on ten cores, absurd on a two-core CI runner and wasteful on thirty-two. The
     * floor of one keeps a single-core runner working rather than dividing itself out of existence.
     */
    maxWorkers: Math.max(1, Math.floor(availableParallelism() / 4)),
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
