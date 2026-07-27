import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AsyncRequestContextAdapter } from '../../../src/infrastructure/logging/async-request-context.adapter.js';
import { NotFoundError, ValidationError } from '../../../src/domain/shared/errors/app.errors.js';
import { createErrorHandler } from '../../../src/presentation/http/error-handler.middleware.js';
import { createRequestContextMiddleware } from '../../../src/presentation/http/middleware/request-context.middleware.js';
import {
  createRootLogger,
  PinoLoggerAdapter,
} from '../../../src/infrastructure/logging/pino-logger.adapter.js';

/**
 * The error handler is mounted last by definition, so it cannot be exercised by adding routes to
 * the real application afterwards — they would sit behind it and never reach it. This suite builds
 * the smallest application that contains it: request context, the routes under test, the handler.
 */
const appThrowing = (handler: RequestHandler): { app: Express; logLines: () => string[] } => {
  const written: string[] = [];
  const logger = createRootLogger(
    { level: 'debug', version: '0.0.0' },
    { write: (line: string) => written.push(line) },
  );
  const requestContext = new AsyncRequestContextAdapter();
  const app = express();

  app.use(
    createRequestContextMiddleware({
      requestContext,
      idGenerator: { next: () => '01J8Z2F5Q3K9V6N0R4T7YB3XQD' },
    }),
  );
  app.get('/boom', handler);
  app.use(createErrorHandler({ logger: new PinoLoggerAdapter(logger), requestContext }));

  return { app, logLines: () => [...written] };
};

const entriesOf = (lines: string[]): Record<string, unknown>[] =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);

describe('domain errors', () => {
  it('answers an AppError with its own status, code and a problem document', async () => {
    const { app } = appThrowing(() => {
      throw new NotFoundError('task_not_found');
    });

    const response = await request(app).get('/boom');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({
      type: 'https://bad-crm.dev/problems/task-not-found',
      status: 404,
      code: 'task_not_found',
      requestId: '01J8Z2F5Q3K9V6N0R4T7YB3XQD',
    });
  });

  /**
   * A 4xx is the API working as designed — it is the caller's request that was wrong. Logging it at
   * `error` with a stack trains everyone to ignore the level that is supposed to page somebody.
   */
  it('logs an expected failure at warn, without a stack trace', async () => {
    const { app, logLines } = appThrowing(() => {
      throw new NotFoundError('task_not_found');
    });

    await request(app).get('/boom');

    const entry = entriesOf(logLines()).find((line) => line['code'] === 'task_not_found');

    expect(entry?.['level']).toBe(40);
    expect(JSON.stringify(entry)).not.toContain('stack');
    expect(entry?.['requestId']).toBe('01J8Z2F5Q3K9V6N0R4T7YB3XQD');
  });
});

describe('unexpected exceptions', () => {
  it('answers 500 with no detail, so an internal message never reaches the client', async () => {
    const { app } = appThrowing(() => {
      throw new Error('column "organization_id" does not exist');
    });

    const response = await request(app).get('/boom');

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ code: 'internal_error', status: 500 });
    expect(response.body.detail).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('organization_id');
  });

  it('logs it at error, with the stack and the request identifier', async () => {
    const { app, logLines } = appThrowing(() => {
      throw new Error('column "organization_id" does not exist');
    });

    await request(app).get('/boom');

    const entry = entriesOf(logLines()).find((line) => line['code'] === 'internal_error');

    expect(entry?.['level']).toBe(50);
    expect(entry?.['requestId']).toBe('01J8Z2F5Q3K9V6N0R4T7YB3XQD');
    expect(JSON.stringify(entry)).toContain('organization_id');
  });

  /**
   * The reason `asyncHandler` does not exist in this codebase (ADR-0002, Express 5): a rejected
   * promise from an `async` handler reaches the error middleware on its own. If this ever regresses,
   * the request hangs until the client times out — with no log line at all.
   */
  it('receives a rejection from an async handler with no wrapper and no try/catch', async () => {
    const { app } = appThrowing(async () => {
      await Promise.resolve();

      throw new NotFoundError('project_not_found');
    });

    const response = await request(app).get('/boom');

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('project_not_found');
  });
});

describe('validation errors', () => {
  it('answers a ZodError as 422 validation_failed', async () => {
    const { app } = appThrowing(() => {
      z.object({ title: z.string() }).parse({ title: 42 });
    });

    const response = await request(app).get('/boom');

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: 'validation_failed', status: 422 });
  });

  it('answers an explicit ValidationError with the same code', async () => {
    const { app } = appThrowing(() => {
      throw new ValidationError({ fields: ['title'] });
    });

    const response = await request(app).get('/boom');

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('validation_failed');
  });
});

describe('a response that already started', () => {
  /**
   * Once the headers are out, a second `res.status().json()` throws `ERR_HTTP_HEADERS_SENT` — inside
   * the error handler, where there is nothing left to catch it, and the original error is lost with
   * it. The handler therefore delegates to Express, which destroys the socket: the client sees an
   * aborted response, which is the truth, and the process stays up.
   */
  it('delegates a partially sent response instead of writing a second one', async () => {
    const { app, logLines } = appThrowing((_request, response) => {
      response.status(200).write('{"partial":');

      throw new Error('failed halfway through streaming');
    });

    await expect(request(app).get('/boom')).rejects.toThrow(/aborted/);
    expect(logLines().join('\n')).not.toContain('ERR_HTTP_HEADERS_SENT');
  });
});
