import { type RequestHandler } from 'express';

import { type IdGeneratorPort } from '@/application/platform/ports/id-generator.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import { type CheckHealthUseCase } from '@/application/platform/use-cases/check-health.use-case.js';
import { type CheckReadinessUseCase } from '@/application/platform/use-cases/check-readiness.use-case.js';

/**
 * The configuration the HTTP layer needs — a deliberate subset of the environment, not `ServerEnv`.
 *
 * `ServerEnv` is produced by `infrastructure/bootstrap`, and `presentation` may not import
 * infrastructure. Restating the three values here is not duplication for its own sake: it documents
 * exactly which variables change the behaviour of the HTTP surface, and it lets a test build an
 * application without constructing a full environment.
 */
export interface HttpServerConfig {
  /** `APP_URL` — CORS allow-list and the switch that decides whether HSTS is sent. */
  readonly appUrl: string;
  /** `CORS_EXTRA_ORIGINS` — additional browser origins, comma-separated. */
  readonly corsExtraOrigins: string | undefined;
  /** `S3_ENDPOINT` — its origin goes into `connect-src`/`img-src` of the CSP (ADR-0023). */
  readonly storageEndpoint: string;
}

/**
 * Everything `createHttpServer` is handed by the composition root.
 *
 * Use-cases and ports only: the application object is assembled from abstractions, so a controller
 * cannot reach a Prisma client even by accident, and the whole HTTP surface can be driven by
 * supertest with in-memory implementations behind it.
 */
export interface HttpServerDependencies {
  readonly config: HttpServerConfig;
  readonly logger: LoggerPort;
  readonly requestContext: RequestContextPort;
  readonly idGenerator: IdGeneratorPort;
  /** The `pino-http` completion-line middleware, built in `infrastructure/logging`. */
  readonly httpLogger: RequestHandler;
  readonly checkHealth: CheckHealthUseCase;
  readonly checkReadiness: CheckReadinessUseCase;
}
