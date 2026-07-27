import type { Express } from 'express';

import { AsyncRequestContextAdapter } from '../../src/infrastructure/logging/async-request-context.adapter.js';
import { buildContainer } from '../../src/infrastructure/bootstrap/container.factory.js';
import { createHttpServer } from '../../src/presentation/http/http-server.factory.js';
import { createRootLogger } from '../../src/infrastructure/logging/pino-logger.adapter.js';
import type { AppContainer } from '../../src/infrastructure/bootstrap/container.types.js';
import type { ServerEnv } from '../../src/infrastructure/bootstrap/env.schema.js';

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
    ARGON2_MEMORY_COST: 19_456,
    ARGON2_TIME_COST: 2,
    ARGON2_PARALLELISM: 1,
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
