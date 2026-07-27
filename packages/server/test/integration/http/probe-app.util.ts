import express, { type Express, type Router } from 'express';

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
}

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

  return { app, logLines: () => [...written] };
};
