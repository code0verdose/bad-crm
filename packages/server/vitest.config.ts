import { fileURLToPath } from 'node:url';

import { availableParallelism } from 'node:os';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `@/*` → `src/*`, the same alias `tsconfig.json` declares and `tsc-alias` rewrites at build
  // time. Vite resolves neither on its own, so without this the suite could only import the
  // sources through relative paths — and the code under test could not use the alias at all.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    /** A share of the machine — see the root `vitest.config.ts` for why, and why it is derived. */
    maxWorkers: Math.max(1, Math.floor(availableParallelism() / 4)),
    /**
     * `test/integration/http/**` runs here on purpose: those specs drive the Express application
     * through supertest, which needs no container and no external service, so keeping them out of
     * `pnpm test` would mean the HTTP surface is only exercised by a task nobody runs locally. The
     * Testcontainers project (STORY-003-06) lands under `test/integration/db/**` behind
     * `pnpm test:integration`, which is where the "needs Docker" boundary actually is.
     *
     * `test/contract/**` is here for the same reason and one more: it is the gate that keeps
     * `docs/api/openapi.yaml` and the Express router from drifting (STORY-003-07), and a gate that
     * only CI knows how to run is a gate nobody runs before pushing. It needs no environment
     * either — the application is built from in-process adapters.
     */
    include: [
      'test/unit/**/*.test.ts',
      'test/integration/http/**/*.test.ts',
      'test/contract/**/*.test.ts',
      // The permission matrix belongs to the same family: it drives the real HTTP stack with
      // in-process adapters, needs no Docker, and is the file a reviewer reads to see whether a
      // change moved what anybody can do. A gate only CI knows how to run is a gate nobody runs.
      'test/permissions/**/*.test.ts',
      'src/**/*.test.ts',
    ],
    environment: 'node',
    // Why: `test/setup/http-agent.setup.ts` — keep-alive off, or supertest's ephemeral ports collide
    // with pooled sockets under load and a random test fails with a parse error.
    setupFiles: ['./test/setup/http-agent.setup.ts'],
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
        // The decision kernel itself, at the same bar as the policies that call it. Its files are
        // `*.util.ts` and `*.errors.ts`, so the glob above never matched them and the 100 % they
        // have today would have been a fact of one run rather than a gate (STORY-011-07, п. 1).
        'src/domain/access/**': { lines: 100, branches: 100 },
        'src/application/**': { lines: 90, branches: 85 },
        'src/infrastructure/**': { lines: 75, branches: 70 },
        'src/presentation/**': { lines: 75, branches: 70 },
      },
    },
  },
});
