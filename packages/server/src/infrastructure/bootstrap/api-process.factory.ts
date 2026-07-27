import { type Express } from 'express';
import { type Logger } from 'pino';

import { APP_INFO } from '@/app-info.constant.js';
import { AsyncRequestContextAdapter } from '@/infrastructure/logging/async-request-context.adapter.js';
import { createRootLogger } from '@/infrastructure/logging/pino-logger.adapter.js';
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
import { createHttpServer } from '@/presentation/http/http-server.factory.js';
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
 * The "infrastructure clients" step is empty today: Prisma arrives in STORY-003-06 and Redis with
 * the queues. It is named here because that is where they are created — before the container, which
 * receives them, and after the logger, which reports their failure.
 */
export const startApiProcess = async (overrides: Partial<ApiProcessSeams> = {}): Promise<void> => {
  const seams: ApiProcessSeams = { ...defaultSeams, ...overrides };
  let logger: Logger | undefined;

  try {
    const env = seams.loadEnvironment();

    const requestContext = new AsyncRequestContextAdapter();
    logger = seams.createLogger(env, requestContext);

    // ── infrastructure clients (Prisma: STORY-003-06, Redis: EPIC-025) go here ──

    const container = buildContainer({ env, logger, requestContext });
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
