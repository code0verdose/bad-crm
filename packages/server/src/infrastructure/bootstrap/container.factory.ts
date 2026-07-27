import { type Logger } from 'pino';

import { CheckHealthUseCase } from '@/application/platform/use-cases/check-health.use-case.js';
import { CheckReadinessUseCase } from '@/application/platform/use-cases/check-readiness.use-case.js';
import { APP_INFO } from '@/app-info.constant.js';
import { AsyncRequestContextAdapter } from '@/infrastructure/logging/async-request-context.adapter.js';
import { createHttpLogger } from '@/infrastructure/logging/http-logger.middleware.js';
import { PinoLoggerAdapter } from '@/infrastructure/logging/pino-logger.adapter.js';
import { optionalServiceProbes } from '@/infrastructure/platform/optional-service-probes.adapter.js';
import { ProcessHealthAdapter } from '@/infrastructure/platform/process-health.adapter.js';
import { ProcessLifecycleAdapter } from '@/infrastructure/platform/process-lifecycle.adapter.js';
import { SystemClockAdapter } from '@/infrastructure/platform/system-clock.adapter.js';
import { UlidIdGeneratorAdapter } from '@/infrastructure/platform/ulid-id-generator.adapter.js';
import { type AppContainer } from '@/infrastructure/bootstrap/container.types.js';
import { type ServerEnv } from '@/infrastructure/bootstrap/env.schema.js';

export interface ContainerInput {
  readonly env: ServerEnv;
  /** The root pino instance; created before the container because the logger has no dependencies. */
  readonly logger: Logger;
  /**
   * Shared with the logger's mixin, so a line written inside a request carries its identifier.
   * Passing it in rather than creating it here keeps "one context per process" visible at the call
   * site instead of hidden in this function.
   */
  readonly requestContext?: AsyncRequestContextAdapter;
}

/**
 * The composition root proper: the only function that constructs concrete adapters and hands them
 * to use-cases.
 *
 * No DI container, by decision (rules/hexagonal-backend.mdc, rule 12 and ADR-0002): explicit
 * assembly is readable top to bottom, needs no decorators or reflection metadata, and makes a
 * dependency cycle a compile error rather than a runtime surprise. The price — a longer function as
 * the system grows — is paid in one file, which is exactly where it should be.
 *
 * It lives in `infrastructure/bootstrap` rather than in `main.ts` so that the whole wiring is
 * testable: `main.ts` is three lines that cannot be unit-tested, and everything worth asserting
 * about the process happens here and in `api-process.factory.ts`.
 */
export const buildContainer = (input: ContainerInput): AppContainer => {
  const requestContext = input.requestContext ?? new AsyncRequestContextAdapter();
  const logger = new PinoLoggerAdapter(input.logger);
  const clock = new SystemClockAdapter();
  const idGenerator = new UlidIdGeneratorAdapter();
  const lifecycle = new ProcessLifecycleAdapter();

  const checkHealth = new CheckHealthUseCase(new ProcessHealthAdapter(APP_INFO.version), clock);
  const checkReadiness = new CheckReadinessUseCase(
    // Live probes for Postgres and Redis are appended here when their clients land (STORY-003-06,
    // EPIC-009). Today the list describes what this installation deliberately does not run.
    optionalServiceProbes(input.env),
    lifecycle,
    clock,
    logger,
  );

  return {
    env: input.env,
    logger,
    lifecycle,
    // Prisma and Redis register themselves here the moment they exist; the shutdown handler needs
    // no change for that (rules/hexagonal-backend.mdc, rule 13).
    shutdownSteps: [],
    http: {
      config: {
        appUrl: input.env.APP_URL,
        corsExtraOrigins: input.env.CORS_EXTRA_ORIGINS,
        storageEndpoint: input.env.S3_ENDPOINT,
      },
      logger,
      requestContext,
      idGenerator,
      httpLogger: createHttpLogger({ logger: input.logger, requestContext }),
      checkHealth,
      checkReadiness,
    },
  };
};
