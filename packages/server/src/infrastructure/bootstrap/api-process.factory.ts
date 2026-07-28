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
  describeDegradations,
  insecureDefaultWarnings,
} from '@/infrastructure/bootstrap/env-features.util.js';
import { loadEnv } from '@/infrastructure/bootstrap/load-env.util.js';
import {
  createShutdownHandler,
  type ClosableServer,
} from '@/infrastructure/bootstrap/shutdown.factory.js';
import { assertRuntimeDbRole } from '@/infrastructure/persistence/prisma/assert-db-role.util.js';
import {
  connectDatabase,
  type DatabaseConnection,
} from '@/infrastructure/persistence/prisma/database.factory.js';
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
   * Refuses the connection when the role it was made as can escape row level security. Separate
   * from `connectDatabase` so the order — pool, then check, then port — is asserted in the test
   * rather than assumed (STORY-005-05).
   */
  readonly verifyDatabaseRole: (database: DatabaseConnection) => Promise<unknown>;
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
  verifyDatabaseRole: (database) => assertRuntimeDbRole(database.base),
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
 * (STORY-005-05). Redis and the queues join the same step when they land.
 */
export const startApiProcess = async (overrides: Partial<ApiProcessSeams> = {}): Promise<void> => {
  const seams: ApiProcessSeams = { ...defaultSeams, ...overrides };
  let logger: Logger | undefined;

  try {
    const env = seams.loadEnvironment();

    const requestContext = new AsyncRequestContextAdapter();
    logger = seams.createLogger(env, requestContext);

    // ── infrastructure clients (Redis: EPIC-025 joins here) ──
    const database = seams.connectDatabase(env, new PinoLoggerAdapter(logger));

    // Before the port, and before any worker: a connection made as the schema owner, as a
    // superuser or as any BYPASSRLS role serves every request correctly and filters nothing. The
    // refusal below is the only signal an operator gets before a tenant reads another tenant's
    // data (invariant 1 of CLAUDE.md, docs/security/rls-design.md).
    await seams.verifyDatabaseRole(database);

    const container = buildContainer({ env, logger, requestContext, database });
    const app = createHttpServer(container.http);

    for (const warning of insecureDefaultWarnings(env)) {
      logger.warn({ warning }, 'insecure development default in use');
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
