import { type RequestHandler } from 'express';

import { type AuthLookupPort } from '@/application/identity/ports/auth-lookup.port.js';
import { type RefreshTokenPort } from '@/application/identity/ports/refresh-token.port.js';
import { type AuthenticateSessionQuery } from '@/application/identity/use-cases/authenticate-session.query.js';
import { type ChangePasswordUseCase } from '@/application/identity/use-cases/change-password.use-case.js';
import { type ConfirmPasswordResetUseCase } from '@/application/identity/use-cases/confirm-password-reset.use-case.js';
import { type EndSessionUseCase } from '@/application/identity/use-cases/end-session.use-case.js';
import { type ListSessionsQuery } from '@/application/identity/use-cases/list-sessions.query.js';
import { type LoginUseCase } from '@/application/identity/use-cases/login.use-case.js';
import { type RefreshSessionUseCase } from '@/application/identity/use-cases/refresh-session.use-case.js';
import { type RegisterOrganizationUseCase } from '@/application/identity/use-cases/register-organization.use-case.js';
import { type RequestPasswordResetUseCase } from '@/application/identity/use-cases/request-password-reset.use-case.js';
import { type IdGeneratorPort } from '@/application/platform/ports/id-generator.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import { type CheckHealthUseCase } from '@/application/platform/use-cases/check-health.use-case.js';
import { type CheckReadinessUseCase } from '@/application/platform/use-cases/check-readiness.use-case.js';
import { type DescribeApiUseCase } from '@/application/platform/use-cases/describe-api.use-case.js';

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
  /**
   * `TRUSTED_PROXY_HOPS` — how many `X-Forwarded-For` entries were written by the operator's own
   * proxies. Decides what `req.ip` is, and therefore what goes into `sessions.ip_hash` and what the
   * rate limiter counts against.
   */
  readonly trustedProxyHops: number;
}

/**
 * Everything `createHttpServer` is handed by the composition root.
 *
 * Use-cases and ports only: the application object is assembled from abstractions, so a controller
 * cannot reach a Prisma client even by accident, and the whole HTTP surface can be driven by
 * supertest with in-memory implementations behind it.
 */
/**
 * The authentication surface, as the HTTP layer sees it: use-cases, plus the two ports the guard
 * needs to resolve a refresh cookie on the one route whose contract accepts one.
 *
 * Grouped rather than spread across `HttpServerDependencies` so that "what does the auth surface
 * depend on" is one declaration, and so that a controller cannot reach a repository — everything
 * here is a use-case or a port (rules/hexagonal-backend.mdc).
 */
export interface IdentityDependencies {
  readonly register: RegisterOrganizationUseCase;
  readonly login: LoginUseCase;
  readonly refresh: RefreshSessionUseCase;
  readonly endSession: EndSessionUseCase;
  readonly changePassword: ChangePasswordUseCase;
  readonly requestPasswordReset: RequestPasswordResetUseCase;
  readonly confirmPasswordReset: ConfirmPasswordResetUseCase;
  readonly listSessions: ListSessionsQuery;
  readonly authenticate: AuthenticateSessionQuery;
  readonly authLookup: AuthLookupPort;
  readonly refreshTokens: RefreshTokenPort;
}

export interface HttpServerDependencies {
  readonly config: HttpServerConfig;
  readonly logger: LoggerPort;
  readonly requestContext: RequestContextPort;
  readonly idGenerator: IdGeneratorPort;
  /** The `pino-http` completion-line middleware, built in `infrastructure/logging`. */
  readonly httpLogger: RequestHandler;
  readonly checkHealth: CheckHealthUseCase;
  readonly checkReadiness: CheckReadinessUseCase;
  readonly describeApi: DescribeApiUseCase;
  readonly identity: IdentityDependencies;
}
