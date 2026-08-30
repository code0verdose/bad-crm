import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AsyncRequestContextAdapter } from '../../../src/infrastructure/logging/async-request-context.adapter.js';
import { accessErrorFor } from '../../../src/domain/access/access.errors.js';
import {
  NotFoundError,
  RateLimitedError,
  ServiceUnavailableError,
  ValidationError,
} from '../../../src/domain/shared/errors/app.errors.js';
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

/** A V8 stack frame: `    at fn (/path/file.ts:12:34)`, wherever in the entry it was filed. */
const STACK_FRAME = /^\s+at .+:\d+:\d+\)?$/m;

/**
 * Every string in a log entry that looks like a stack trace, at any depth and under any key.
 *
 * The property is «this line carries no trace», and a trace is recognisable by its frames. Searching
 * the serialized entry for the substring `stack` asks a different question — what pino named the
 * field — which the next author answers differently by writing `trace:` or `err:`.
 */
const framesIn = (value: unknown): string[] => {
  if (typeof value === 'string') return STACK_FRAME.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(framesIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(framesIn);

  return [];
};

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
   * Two refusals of the same operation, distinguishable by a machine.
   *
   * Both answer `project_forbidden`, because that is what the client translates; what separates
   * «you are missing the permission» from «your level on this object is too low» is the `reason`
   * extension member, and the screen that explains a denial offers a different remedy for each.
   * Without it, every 403 in this product would be one sentence and every support ticket about one
   * would start with reading the source.
   */
  it('carries the refusal reason of an access denial, and only of one', async () => {
    const { app } = appThrowing(() => {
      throw accessErrorFor('insufficient_acl_level', 'project');
    });

    const denial = await request(app).get('/boom');

    expect(denial.status).toBe(403);
    expect(denial.body).toMatchObject({
      code: 'project_forbidden',
      reason: 'insufficient_acl_level',
    });

    const { app: plain } = appThrowing(() => {
      throw new NotFoundError('task_not_found');
    });

    // Not every refusal comes from the permission layer, and one that does not must not pretend to:
    // an unparsed body or a rate limit has no reason to give. Asserted together with the code that
    // must be there, so an empty body for some unrelated reason cannot pass for the property.
    const plainBody = (await request(plain).get('/boom')).body as Record<string, unknown>;

    expect(plainBody).toMatchObject({ code: 'task_not_found' });
    expect(plainBody).not.toHaveProperty('reason');
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
    expect(entry?.['requestId']).toBe('01J8Z2F5Q3K9V6N0R4T7YB3XQD');
    // A stack is recognised by its frames, not by the seven letters of the field pino happens to
    // call it: `not.toContain('stack')` is satisfied by the whole trace filed under `trace`, `err`
    // or anything else somebody reaches for next.
    expect(framesIn(entry)).toEqual([]);
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
    // CONTROL for the detector the warn case asserts empty: handed a line that does carry a trace,
    // it finds one. Without this, a detector that recognises nothing would report every line clean.
    expect(framesIn(entry).length).toBeGreaterThan(0);
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
      throw new ValidationError([{ path: 'title', code: 'too_small', message: 'too short' }]);
    });

    const response = await request(app).get('/boom');

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('validation_failed');
    expect(response.body.errors).toEqual([
      { path: 'title', code: 'too_small', message: 'too short' },
    ]);
  });

  /**
   * A schema parsed anywhere other than the `validate` middleware — a webhook payload, an external
   * response — has to produce the same body, or a client would need two error parsers.
   */
  it('turns a bare ZodError into the same per-field list', async () => {
    const { app } = appThrowing(() => {
      z.object({ title: z.string() }).parse({ title: 42 });
    });

    const response = await request(app).get('/boom');

    expect(response.body.errors).toEqual([
      { path: 'title', code: 'invalid_type', message: expect.any(String) },
    ]);
  });
});

describe('a response that already started', () => {
  /**
   * Once the headers are out, a second `res.status().json()` throws `ERR_HTTP_HEADERS_SENT` — inside
   * the error handler, where there is nothing left to catch it, and the original error is lost with
   * it. The handler therefore delegates to Express, which destroys the socket: the client sees an
   * aborted response, which is the truth, and the process stays up.
   *
   * **The abort is not the evidence.** Both halves of the branch end in a destroyed socket: without
   * the guard the second write throws, Express catches it and `finalhandler` destroys the connection
   * just the same — measured, not reasoned. `rejects.toThrow(/aborted/)` therefore states a fact
   * that holds whether or not the guard exists, and the case that carried only it survived
   * `if (response.headersSent)` becoming `if (false)`.
   *
   * What does separate the two is what the handler *did*: `next(error)` stands before every
   * `logger.*` call, so a delegated request leaves no line of ours at all — while the same request
   * with the guard removed leaves one `unhandled error` at level 50, written moments before the
   * throw that loses the response. Emptiness of our own log is the delegation, so that is what is
   * asserted.
   */
  it('delegates a partially sent response instead of writing a second one', async () => {
    const { app, logLines } = appThrowing((incoming, response) => {
      if (incoming.query['partial'] === undefined) throw new NotFoundError('task_not_found');

      response.status(200).write('{"partial":');

      throw new Error('failed halfway through streaming');
    });

    await expect(request(app).get('/boom?partial=1')).rejects.toThrow(/aborted/);
    expect(entriesOf(logLines())).toEqual([]);

    // CONTROL: the same application and the same sink, on a request whose response had not started
    // — a line arrives. Without it the emptiness above is satisfied by a logger that records nothing
    // at all, which is how an assertion on a log this branch never reaches came to pass.
    await request(app).get('/boom');

    expect(entriesOf(logLines()).map((line) => line['code'])).toEqual(['task_not_found']);
  });
});

/**
 * `Retry-After` is set from one place for every error that carries a number of seconds — the 429 of
 * the rate limiter and the 503 of the argon2 queue alike (STORY-013-06, acceptance 2). A second
 * mechanism for the same header is how one of the two ends up shipping without it.
 */
describe('Retry-After', () => {
  it('carries the seconds of a rate-limited refusal', async () => {
    const { app } = appThrowing(() => {
      throw new RateLimitedError(42);
    });

    const response = await request(app).get('/boom');

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('42');
  });

  it('carries the seconds of an overloaded dependency that named one', async () => {
    const { app } = appThrowing(() => {
      throw new ServiceUnavailableError({ dependency: 'password-hashing' }, undefined, 2);
    });

    const response = await request(app).get('/boom');

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('service_unavailable');
    expect(response.headers['retry-after']).toBe('2');
  });

  /** CONTROL: a dependency failure with no answer to «when» must not invent one. */
  it('CONTROL: sends no header when the error names no delay', async () => {
    const { app } = appThrowing(() => {
      throw new ServiceUnavailableError({ dependency: 'redis' });
    });

    const response = await request(app).get('/boom');

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBeUndefined();
  });
});
