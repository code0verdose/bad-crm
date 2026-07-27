import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The database integration project: `pnpm test:integration`.
 *
 * Separate from `vitest.config.ts` because the boundary is Docker, not the word "integration".
 * Everything here starts a real PostgreSQL through Testcontainers, so it cannot run in the fast
 * loop or on a machine without a container runtime — while `test/integration/http/**`, which only
 * needs supertest, stays in `pnpm test` where it is actually run.
 *
 * No coverage thresholds: the tiers of `rules/testing.mdc` §7 are measured by `pnpm test`, and a
 * second, partial measurement over the same sources would either double-count or contradict it.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['test/integration/db/**/*.test.ts'],
    environment: 'node',
    /**
     * One container for the whole run, started once and reused by every file — starting one per
     * file would add ten seconds each and make the suite something people skip.
     */
    globalSetup: ['test/integration/db/setup/testcontainers.setup.ts'],
    /**
     * Files share that container and clean up with `TRUNCATE ... RESTART IDENTITY CASCADE` between
     * tests. Two files truncating concurrently would break each other for reasons unrelated to what
     * they assert, so they run one after another.
     */
    fileParallelism: false,
    /** Pulling the image and running the bootstrap on a cold machine is minutes, not seconds. */
    hookTimeout: 300_000,
    testTimeout: 60_000,
  },
});
