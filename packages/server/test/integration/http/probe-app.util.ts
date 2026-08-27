import { createServer, type Server } from 'node:http';

import express, { type Express, type Router } from 'express';
import { afterEach } from 'vitest';

import { AsyncRequestContextAdapter } from '../../../src/infrastructure/logging/async-request-context.adapter.js';
import {
  createRootLogger,
  PinoLoggerAdapter,
} from '../../../src/infrastructure/logging/pino-logger.adapter.js';
import { createErrorHandler } from '../../../src/presentation/http/error-handler.middleware.js';
import { createNotFoundMiddleware } from '../../../src/presentation/http/middleware/not-found.middleware.js';
import { createRequestContextMiddleware } from '../../../src/presentation/http/middleware/request-context.middleware.js';

/** Fixed, so a test can assert the identifier that ties a response to its log line. */
export const PROBE_REQUEST_ID = '01J8Z2F5Q3K9V6N0R4T7YB3XQD';

export interface ProbeApp {
  readonly app: Express;
  readonly logLines: () => string[];
  /**
   * A listening server, opened once and reused — never a fresh one per request.
   *
   * `request(app)` hands supertest a bare handler, and supertest then binds a **new** ephemeral port
   * for every single call. This file's suite builds a probe per test and makes several calls
   * against it, so the package-wide total runs to thousands of listen/close cycles; under load the
   * OS eventually hands out a port whose previous socket has not finished closing, and the request
   * lands on somebody else's application. That surfaces as `socket hang up`, `Parse Error`, or —
   * worst, because it looks like a real defect — another app's perfectly honest `400`.
   *
   * The same fix already exists on `AuthApp#server()` (`test/support/auth-app.util.ts`); this is the
   * one remaining suite that builds its own Express instead of that harness.
   */
  readonly server: () => Server;
}

/** Every listener `ProbeApp#server()` has opened for the test that is currently running. */
const openProbeServers = new Set<Server>();

afterEach(() => {
  for (const server of openProbeServers) server.close();
  openProbeServers.clear();
});

/**
 * The smallest application that contains the request pipeline under test: request context, JSON
 * body parsing, the routes a suite wants to exercise, the not-found middleware and the error
 * handler.
 *
 * It is not `createHttpServer`, for two reasons. The error handler is mounted last by definition,
 * so routes added to a finished application would sit *behind* it and never reach it — a probe
 * route has to be registered while the chain is being built. And what STORY-003-04 is about is the
 * validation → error → problem-document path; helmet, CORS and HSTS are a different contract with
 * their own suites, and pulling them in here would make every assertion below depend on them.
 */
export const createProbeApp = (mount: (router: Router) => void): ProbeApp => {
  const written: string[] = [];
  const logger = createRootLogger(
    { level: 'debug', version: '0.0.0' },
    { write: (line: string) => written.push(line) },
  );
  const requestContext = new AsyncRequestContextAdapter();
  const app = express();
  const router = express.Router();

  app.use(
    createRequestContextMiddleware({
      requestContext,
      idGenerator: { next: () => PROBE_REQUEST_ID },
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  mount(router);
  app.use(router);

  app.use(createNotFoundMiddleware());
  app.use(createErrorHandler({ logger: new PinoLoggerAdapter(logger), requestContext }));

  let listening: Server | undefined;
  const server = (): Server => {
    if (listening === undefined) {
      listening = createServer(app);
      listening.listen(0);
      openProbeServers.add(listening);
    }

    return listening;
  };

  return { app, server, logLines: () => [...written] };
};
