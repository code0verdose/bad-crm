import { type Express } from 'express';
import { type Logger } from 'pino';

import { APP_INFO } from '@/app-info.constant.js';
import { AsyncRequestContextAdapter } from '@/infrastructure/logging/async-request-context.adapter.js';
import {
  PinoLoggerAdapter,
  createRootLogger,
} from '@/infrastructure/logging/pino-logger.adapter.js';
import { buildContainer } from '@/infrastructure/bootstrap/container.factory.js';
import {
  blockingDegradationWarnings,
  describeDegradations,
  insecureDefaultWarnings,
} from '@/infrastructure/bootstrap/env-features.util.js';
import { loadEnv } from '@/infrastructure/bootstrap/load-env.util.js';
import { type StartupCheck } from '@/infrastructure/bootstrap/container.types.js';
import {
  createShutdownHandler,
  type ClosableServer,
} from '@/infrastructure/bootstrap/shutdown.factory.js';
import { assertRuntimeDbRole } from '@/infrastructure/persistence/prisma/assert-db-role.util.js';
import {
  connectDatabase,
  type DatabaseConnection,
} from '@/infrastructure/persistence/prisma/database.factory.js';
import { connectRedis, type RedisConnection } from '@/infrastructure/redis/redis.client.js';
import { createHttpServer } from '@/presentation/http/http-server.factory.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type ServerEnv } from '@/infrastructure/bootstrap/env.schema.js';

/** Hard deadline for graceful shutdown (stack.md): a stuck handler must not block a deploy. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * The five things this function does that touch the outside world, injected so the startup sequence
 * itself can be asserted.
 *
 * They are seams, not configuration: the defaults are what the process runs with, and a test
 * replaces them to observe the order of the steps, the port that was opened and the exit code —
 * none of which is observable from outside a function that calls `process.exit` for real.
 */
/**
 * A listening server: closable, and able to report what it actually bound.
 *
 * `address()` matters because `PORT=0` is a legitimate configuration — the kernel picks a free port,
 * which is how the integration suite starts a real process without colliding with a dev server. The
 * startup line then has to report the port an operator can reach, not the zero from the file.
 */
export interface ListeningServer extends ClosableServer {
  address?(): string | { port: number } | null;
}

export interface ApiProcessSeams {
  readonly loadEnvironment: () => ServerEnv;
  readonly createLogger: (env: ServerEnv, requestContext: AsyncRequestContextAdapter) => Logger;
  readonly connectDatabase: (env: ServerEnv, logger: LoggerPort) => DatabaseConnection;
  /**
   * Opened beside the pool and before the port, because the rate limiter fails closed: without a
   * connection every sign-in is refused 503, so this is not an optional client that can arrive
   * later. It does not *wait* for the connection — see `connectRedis`.
   */
  readonly connectRedis: (env: ServerEnv, logger: LoggerPort) => RedisConnection;
  /**
   * Refuses the connection when the role it was made as can escape row level security. Separate
   * from `connectDatabase` so the order — pool, then check, then port — is asserted in the test
   * rather than assumed (STORY-005-05).
   */
  readonly verifyDatabaseRole: (database: DatabaseConnection) => Promise<unknown>;
  /**
   * Runs whatever the container asked to have verified before the port opens — today the role of
   * the `app_auth` pool, which only exists when `DATABASE_AUTH_URL` is set.
   *
   * A seam because the checks talk to a database: without it every assertion about the *order* of
   * the startup sequence would need a live PostgreSQL to reach the line after them.
   */
  readonly runStartupChecks: (checks: readonly StartupCheck[]) => Promise<void>;
  readonly listen: (app: Express, port: number) => Promise<ListeningServer>;
  readonly onSignal: (signal: string, handler: () => void) => void;
  readonly exit: (code: number) => void;
  /** Used for a failure that happens before a logger exists — a broken `LOG_LEVEL`, for instance. */
  readonly reportFatal: (message: string) => void;
}

const defaultSeams: ApiProcessSeams = {
  loadEnvironment: () => loadEnv(),
  createLogger: (env, requestContext) =>
    createRootLogger({ level: env.LOG_LEVEL, version: APP_INFO.version, requestContext }),
  connectDatabase: (env, logger) => connectDatabase({ url: env.DATABASE_URL, logger }),
  connectRedis: (env, logger) => connectRedis({ url: env.REDIS_URL, logger }),
  verifyDatabaseRole: (database) => assertRuntimeDbRole(database.base),
  runStartupChecks: async (checks) => {
    for (const check of checks) {
      await check.run();
    }
  },
  listen: (app, port) =>
    new Promise((resolve, reject) => {
      const server = app.listen(port, () => resolve(server));

      server.on('error', reject);
    }),
  onSignal: (signal, handler) => {
    process.on(signal, handler);
  },
  exit: (code) => {
    process.exit(code);
  },
  reportFatal: (message) => {
    process.stderr.write(`${message}\n`);
  },
};

/**
 * Start the API process, in the order STORY-003-01 fixes:
 * `loadEnv()` → logger → infrastructure clients → `buildContainer()` → `listen(PORT)`.
 *
 * The order is a safety property, not tidiness: **configuration is validated before the port is
 * open**. A process that starts listening and then discovers a missing `APP_ENCRYPTION_KEY` has
 * already accepted requests it cannot serve, and a rolling deployment has already been told it is
 * healthy. Failure at any step produces one readable sentence and exit code 1 — never a stack trace
 * and never a half-started process.
 *
 * The database is part of that order and not an afterthought. The pool is opened after the logger —
 * which is what reports its failure — and the role it connected as is verified **before** the port,
 * because a role that can escape row level security produces no error at all: every request is
 * served, nothing is filtered, and the first symptom is one tenant reading another's data
 * (STORY-005-05). Redis is opened in the same step — the rate limiter fails closed, so a process
 * without it refuses every sign-in — and the queues join it when they land.
 */
export const startApiProcess = async (overrides: Partial<ApiProcessSeams> = {}): Promise<void> => {
  const seams: ApiProcessSeams = { ...defaultSeams, ...overrides };
  let logger: Logger | undefined;

  try {
    const env = seams.loadEnvironment();

    const requestContext = new AsyncRequestContextAdapter();
    logger = seams.createLogger(env, requestContext);

    // ── infrastructure clients ──
    const loggerPort = new PinoLoggerAdapter(logger);
    const database = seams.connectDatabase(env, loggerPort);
    const redis = seams.connectRedis(env, loggerPort);

    // Before the port, and before any worker: a connection made as the schema owner, as a
    // superuser or as any BYPASSRLS role serves every request correctly and filters nothing. The
    // refusal below is the only signal an operator gets before a tenant reads another tenant's
    // data (invariant 1 of CLAUDE.md, docs/security/rls-design.md).
    await seams.verifyDatabaseRole(database);

    const container = buildContainer({ env, logger, requestContext, database, redis });

    // Whatever the container built and can verify — today the `app_auth` pool, whose role decides
    // whether the authentication path is the narrow credential it is documented to be. Before the
    // port, like the check above and for the same reason: the failures these catch have no
    // functional symptom, so the refusal to start is the only signal there is.
    await seams.runStartupChecks(container.startupChecks);

    const app = createHttpServer(container.http);

    for (const warning of insecureDefaultWarnings(env)) {
      logger.warn({ warning }, 'insecure development default in use');
    }

    // Not a field of the listening line below: a subsystem that is *gone* rather than reduced has
    // to be findable by level. Without `DATABASE_AUTH_URL` this container is green, `/ready` is
    // 200, every route answers — and nobody can sign in (rules/self-host-packaging.mdc, rule 2).
    for (const warning of blockingDegradationWarnings(env)) {
      logger.warn({ warning }, 'a required subsystem is not configured');
    }

    const server = await seams.listen(app, env.PORT);
    const address = server.address?.();

    logger.info(
      {
        port: typeof address === 'object' && address !== null ? address.port : env.PORT,
        nodeEnv: env.NODE_ENV,
        degradations: describeDegradations(env),
      },
      'api process listening',
    );

    const shutdown = createShutdownHandler({
      server,
      lifecycle: container.lifecycle,
      steps: container.shutdownSteps,
      logger: container.logger,
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
      exit: seams.exit,
    });

    for (const signal of SIGNALS) {
      seams.onSignal(signal, () => void shutdown(signal));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Both channels on purpose: the logger may not exist yet (the failure can *be* the logger's
    // configuration), and stderr is what an operator sees in `docker logs` when it does not.
    logger?.fatal({ err: error }, 'api process failed to start');
    seams.reportFatal(`Bad CRM failed to start.\n${message}`);
    seams.exit(1);
  }
};
