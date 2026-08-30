import type { Express } from 'express';
import type { Logger } from 'pino';

import { AsyncRequestContextAdapter } from '../../src/infrastructure/logging/async-request-context.adapter.js';
import { buildContainer } from '../../src/infrastructure/bootstrap/container.factory.js';
import { createHttpServer } from '../../src/presentation/http/http-server.factory.js';
import {
  createRootLogger,
  PinoLoggerAdapter,
} from '../../src/infrastructure/logging/pino-logger.adapter.js';
import { createHttpLogger } from '../../src/infrastructure/logging/http-logger.middleware.js';
import { detachedRateLimit } from '../../src/infrastructure/rate-limit/detached-rate-limit.adapter.js';
import { RecordClientErrorUseCase } from '../../src/application/platform/use-cases/record-client-error.use-case.js';
import type { AppContainer } from '../../src/infrastructure/bootstrap/container.types.js';
import type { ServerEnv } from '../../src/infrastructure/bootstrap/env.schema.js';
import type { HttpServerDependencies } from '../../src/presentation/http/http-server.types.js';

const VALID_ENCRYPTION_KEY = `${'A'.repeat(43)}=`;

/**
 * A parsed environment, built directly rather than through `loadEnv`: these suites are about the
 * HTTP surface, and going through the parser would couple every one of them to the env schema.
 */
export const testEnv = (overrides: Partial<ServerEnv> = {}): ServerEnv =>
  ({
    NODE_ENV: 'test',
    PORT: 3000,
    APP_URL: 'https://crm.example.com',
    DATABASE_URL: 'postgres://app_user:secret@localhost:5432/bad_crm',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'j'.repeat(32),
    APP_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'bad-crm',
    S3_ACCESS_KEY: 'access-key',
    S3_SECRET_KEY: 'secret-key',
    S3_REGION: 'us-east-1',
    S3_FORCE_PATH_STYLE: true,
    AI_ENABLED: false,
    LOG_LEVEL: 'debug',
    RUN_WORKERS_IN_PROCESS: false,
    TRUSTED_PROXY_HOPS: 0,
    ARGON2_MEMORY_COST: 19_456,
    ARGON2_TIME_COST: 2,
    ARGON2_PARALLELISM: 1,
    AUTH_ARGON2_MAX_CONCURRENCY: 4,
    AUTH_ARGON2_QUEUE_TIMEOUT_MS: 2_000,
    ...overrides,
  }) as ServerEnv;

export interface TestApp {
  readonly app: Express;
  readonly container: AppContainer;
  /** Every JSON line the logger produced, in order. */
  readonly logLines: () => string[];
}

/** The real container and the real Express application, with the log written to memory. */
export const createTestApp = (overrides: Partial<ServerEnv> = {}): TestApp => {
  const written: string[] = [];
  const env = testEnv(overrides);
  // Same wiring as `api-process.factory.ts`: one request context, shared by the logger's mixin and
  // the middleware, so the assertions about `requestId` in log lines exercise the real path.
  const requestContext = new AsyncRequestContextAdapter();
  const logger = createRootLogger(
    { level: env.LOG_LEVEL, version: '0.0.0', requestContext },
    { write: (line: string) => written.push(line) },
  );
  const container = buildContainer({ env, logger, requestContext });

  return {
    app: createHttpServer(container.http),
    container,
    logLines: () => [...written],
  };
};

/**
 * The platform half of `HttpServerDependencies` — everything `createHttpServer` needs that is
 * neither `identity` nor `iam` — with a log this caller alone can read.
 *
 * ## Why it exists
 *
 * `createAuthApp` builds the whole container and then throws away `identity` and `iam`, because the
 * point of that harness is the wire in front of in-memory ports. One of the things it throws away
 * costs about 20 ms to construct: `Argon2PasswordHasher` hashes 32 random bytes in its constructor,
 * at the real OWASP cost, so that the "no such user" branch of sign-in cannot be told apart by a
 * stopwatch. That dummy hash is right in the product and must stay — but the suites never verify
 * against it, because the identity they run is wired to `FakePasswordHasher`.
 *
 * Measured on this machine (10 cores, under load, so the absolute numbers are pessimistic):
 * 196 × `buildContainer` = 4.9 s, of which 196 × `hashSync` = 4.1 s. `test/permissions` alone
 * builds one application per matrix cell.
 *
 * ## What is shared and why that is safe
 *
 * The container is built **once per environment** and its stateless members are handed out again:
 * `config` (a plain object derived from the env that keys the cache), `requestContext` (an
 * `AsyncLocalStorage` whose state is per-request, never per-app), `idGenerator` (`ulid()` and
 * `randomUUID()`, no counters), `checkHealth`, `checkReadiness` and `describeApi` (a clock and
 * version strings; the readiness probes are the detached ones, since no database or Redis client is
 * passed here). None of them can carry a value from one test into the next.
 *
 * Everything that *does* accumulate is rebuilt per call, so the isolation is exactly what a fresh
 * container gave: the pino instance and its sink, the `LoggerPort` over it, the completion-line
 * middleware, and `recordClientError`, which is the one platform use-case that writes to the log.
 * Each caller therefore reads its own `logLines()` and nobody else's — no ordering, no clearing, no
 * shared array.
 *
 * ## What stops being checked
 *
 * Say it plainly: an `AuthApp` no longer proves that `buildContainer` composes. If a future wiring
 * bug makes the composition root throw for the second call onward, or leaves a field undefined only
 * under some env, these 22 suites would not see it. Three things stand in for that. `createTestApp`
 * above is untouched and still builds a full container per call in eleven suites, `test/contract`
 * and `test/integration/http/bootstrap.test.ts` among them. The spread below is typed as
 * `HttpServerDependencies`, so a *new required* member of that interface is a compile error here
 * rather than a silent hole — an optional one (`metrics`) is not, which is why `METRICS_ENABLED` is
 * refused outright below instead of being quietly shared. And the objects handed out are the real
 * ones the composition root built, not stand-ins.
 */
export interface TestPlatform {
  readonly http: Omit<HttpServerDependencies, 'identity' | 'iam'>;
  /** Every JSON line this platform's logger produced, in order — private to this caller. */
  readonly logLines: () => string[];
}

interface CachedPlatform {
  readonly container: AppContainer;
  readonly requestContext: AsyncRequestContextAdapter;
}

const platformCache = new Map<string, CachedPlatform>();

const cachedPlatform = (overrides: Partial<ServerEnv>): CachedPlatform => {
  if ('METRICS_ENABLED' in overrides) {
    // A prom-client registry counts across every application handed the same collector, which is
    // the one piece of `http` that would carry a number from one test into the next. Rather than
    // reason about which suite reads it, refuse: `createTestApp` builds a private container.
    throw new Error('METRICS_ENABLED cannot be shared between apps — use createTestApp instead');
  }

  const key = JSON.stringify(overrides, Object.keys(overrides).sort());
  const hit = platformCache.get(key);

  if (hit !== undefined) return hit;

  const requestContext = new AsyncRequestContextAdapter();
  const built: CachedPlatform = {
    // The log of the cached container goes nowhere on purpose: every consumer is handed its own
    // logger below, and a line written through this one would belong to no test.
    container: buildContainer({
      env: testEnv(overrides),
      logger: createRootLogger(
        { level: 'silent', version: '0.0.0', requestContext },
        { write: () => undefined },
      ),
      requestContext,
    }),
    requestContext,
  };

  platformCache.set(key, built);

  return built;
};

export const createTestPlatform = (overrides: Partial<ServerEnv> = {}): TestPlatform => {
  const { container, requestContext } = cachedPlatform(overrides);
  const written: string[] = [];
  const pino: Logger = createRootLogger(
    { level: container.env.LOG_LEVEL, version: '0.0.0', requestContext },
    { write: (line: string) => written.push(line) },
  );
  const logger = new PinoLoggerAdapter(pino);

  return {
    http: {
      ...container.http,
      logger,
      httpLogger: createHttpLogger({ logger: pino, requestContext }),
      // The same two arguments the composition root passes when no Redis client exists, which is
      // every application this harness builds.
      recordClientError: new RecordClientErrorUseCase(detachedRateLimit(), logger),
    },
    logLines: () => [...written],
  };
};
