import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The container-backed integration run: `pnpm test:integration`.
 *
 * Separate from `vitest.config.ts` because the boundary is Docker, not the word "integration".
 * Everything here starts a real service through Testcontainers, so it cannot run in the fast loop
 * or on a machine without a container runtime — while `test/integration/http/**`, which only needs
 * supertest, stays in `pnpm test` where it is actually run.
 *
 * **Two projects, because they need different containers.** The database suites share one
 * PostgreSQL started by a `globalSetup`; the service suites (Redis for the rate limiter, Mailpit
 * for outgoing mail) start their own and would pay for a PostgreSQL they never query. Running them
 * under the database project would also serialise them behind its truncation lock for no reason.
 *
 * `test/repo/integration-coverage.test.ts` asserts that every directory under `test/integration`
 * is claimed by one of these projects or by `vitest.config.ts`. That guard exists because both
 * `test/integration/mail` and `test/integration/rate-limit` were written, passed locally under a
 * hand-made config, and were then run by **no project at all** — the suites existed, the command
 * reported success, and nothing in between noticed.
 *
 * No coverage thresholds: the tiers of `rules/testing.mdc` §7 are measured by `pnpm test`, and a
 * second, partial measurement over the same sources would either double-count or contradict it.
 */

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

/** Pulling an image and running a bootstrap on a cold machine is minutes, not seconds. */
const CONTAINER_TIMEOUTS = { hookTimeout: 300_000, testTimeout: 60_000 };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'db',
          include: ['test/integration/db/**/*.test.ts'],
          environment: 'node',
          /**
           * One container for the whole run, started once and reused by every file — starting one
           * per file would add ten seconds each and make the suite something people skip.
           */
          globalSetup: ['test/integration/db/setup/testcontainers.setup.ts'],
          /**
           * Files share that container and clean up with `TRUNCATE ... RESTART IDENTITY CASCADE`
           * between tests. Two files truncating concurrently would break each other for reasons
           * unrelated to what they assert, so they run one after another.
           */
          fileParallelism: false,
          ...CONTAINER_TIMEOUTS,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'services',
          include: ['test/integration/{mail,rate-limit}/**/*.test.ts'],
          environment: 'node',
          ...CONTAINER_TIMEOUTS,
        },
      },
    ],
  },
});
