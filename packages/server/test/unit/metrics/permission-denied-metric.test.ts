import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { assertAllowed, deny } from '../../../src/domain/access/decision.util.js';
import { NotFoundError } from '../../../src/domain/shared/errors/app.errors.js';
import { AsyncRequestContextAdapter } from '../../../src/infrastructure/logging/async-request-context.adapter.js';
import {
  createRootLogger,
  PinoLoggerAdapter,
} from '../../../src/infrastructure/logging/pino-logger.adapter.js';
import { createPromMetrics } from '../../../src/infrastructure/metrics/prom-client.adapter.js';
import { createErrorHandler } from '../../../src/presentation/http/error-handler.middleware.js';
import { createRequestContextMiddleware } from '../../../src/presentation/http/middleware/request-context.middleware.js';

/**
 * `permission_denied_total{reason}` — STORY-016-02, acceptance 7: a refusal on a `GET` leaves no
 * audit row, only this counter, and the label is what makes it worth having. `permission_not_granted`
 * spread across an organization is a role that needs widening; `tenant_mismatch` climbing on one
 * instance is somebody walking identifiers.
 *
 * The counter is incremented in the error handler and nowhere else, and this suite exercises **that**
 * path rather than the adapter method: a route that refuses through the real `assertAllowed`, the
 * real error handler, the real registry. A test that called `metrics.incrementPermissionDenied`
 * directly would stay green with the handler never wired — which is the only failure mode that
 * matters here.
 */
const appRefusing = (handler: RequestHandler): { app: Express; render: () => Promise<string> } => {
  const logger = createRootLogger(
    { level: 'silent', version: '0.0.0' },
    { write: () => undefined },
  );
  const requestContext = new AsyncRequestContextAdapter();
  const metrics = createPromMetrics();
  const app = express();

  app.use(
    createRequestContextMiddleware({
      requestContext,
      idGenerator: { next: () => '01J8Z2F5Q3K9V6N0R4T7YB3XQD' },
    }),
  );
  app.get('/guarded', handler);
  app.use(createErrorHandler({ logger: new PinoLoggerAdapter(logger), requestContext, metrics }));

  return { app, render: () => metrics.render() };
};

const seriesFor = (rendered: string, reason: string): string[] =>
  rendered
    .split('\n')
    .filter((line) => line.startsWith(`permission_denied_total{reason="${reason}"}`));

describe('a refusal that reached the HTTP surface', () => {
  it('counts a missing capability under its own reason', async () => {
    const { app, render } = appRefusing(() => {
      assertAllowed(deny('permission_not_granted'), 'user');
    });

    const response = await request(app).get('/guarded');

    expect(response.status).toBe(403);
    expect(seriesFor(await render(), 'permission_not_granted')).toEqual([
      'permission_denied_total{reason="permission_not_granted"} 1',
    ]);
  });

  /**
   * The reason an operator actually watches. It answers 404 like a missing row does — that is
   * invariant 2 — so the status code cannot tell the two apart and the label is the only place the
   * difference survives.
   */
  it('separates a cross-tenant refusal from a missing capability', async () => {
    const { app, render } = appRefusing(() => {
      assertAllowed(deny('tenant_mismatch'), 'role');
    });

    const response = await request(app).get('/guarded');
    const rendered = await render();

    expect(response.status).toBe(404);
    expect(seriesFor(rendered, 'tenant_mismatch')).toEqual([
      'permission_denied_total{reason="tenant_mismatch"} 1',
    ]);
    expect(seriesFor(rendered, 'permission_not_granted')).toEqual([]);
  });

  it('adds up repeated refusals of the same reason in one series', async () => {
    const { app, render } = appRefusing(() => {
      assertAllowed(deny('denied_by_override'), 'user');
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(app).get('/guarded');
    }

    expect(seriesFor(await render(), 'denied_by_override')).toEqual([
      'permission_denied_total{reason="denied_by_override"} 3',
    ]);
  });

  /**
   * CONTROL. Without it the suite passes for an implementation that counts every error, and
   * «denials are climbing» would mean «somebody requested a page that does not exist».
   */
  it('CONTROL: does not count a failure that is not a refusal', async () => {
    const { app, render } = appRefusing(() => {
      throw new NotFoundError('task_not_found');
    });

    await request(app).get('/guarded');

    expect(await render()).not.toContain('permission_denied_total{');
  });

  /**
   * CONTROL. The label set is closed — `DenyReason` — and nothing carrying an identifier may reach
   * it. `/metrics` is read by whatever can reach the port, and one series per user id is a memory
   * leak with a scrape interval attached.
   */
  it('CONTROL: carries no label other than the reason', async () => {
    const { app, render } = appRefusing(() => {
      assertAllowed(deny('insufficient_acl_level'), 'user');
    });

    await request(app).get('/guarded');

    const line = (await render())
      .split('\n')
      .find((candidate) => candidate.startsWith('permission_denied_total{'));

    expect(line).toBe('permission_denied_total{reason="insufficient_acl_level"} 1');
  });
});
