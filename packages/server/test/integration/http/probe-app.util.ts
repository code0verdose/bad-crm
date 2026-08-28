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

/**
 * How to retire every listener `ProbeApp#server()` opened for the test that is currently running.
 *
 * Closers rather than servers, for the reason spelled out on the same set in
 * `test/support/auth-app.util.ts`: closing a listener is half the job, because the `ProbeApp` that
 * opened it still holds it memoized and can outlive the test that first asked (`beforeAll`). Only
 * the owner can clear that memo, so the owner registers how.
 */
const openProbeServers = new Set<() => void>();

afterEach(() => {
  for (const retire of openProbeServers) retire();
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
      const opened = createServer(app);
      opened.listen(0);
      listening = opened;
      // Closing and forgetting are one act, registered together — otherwise the next test is handed
      // a listener that is already closed. Re-entering here opens a fresh one instead.
      openProbeServers.add(() => {
        listening = undefined;
        // Connections first, listener second. `close()` stops new sockets and lets existing ones
        // finish, so a socket pooled by a client outlives the server it belongs to — and the
        // operating system is free to hand the same port to the next listener, at which point that
        // pooled socket points at a stranger. That is the mechanism `test/setup/http-agent.setup.ts`
        // documents behind «Parse Error: Expected HTTP/…»; keep-alive is off there, which removes
        // the pool, and this removes the sockets themselves. Belt and braces on purpose: the class
        // has been observed once since keep-alive was disabled, and neither half is expensive.
        opened.closeAllConnections();
        opened.close();
      });
    }

    return listening;
  };

  return { app, server, logLines: () => [...written] };
};
