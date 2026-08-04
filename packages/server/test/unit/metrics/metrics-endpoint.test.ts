import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createPromMetrics } from '../../../src/infrastructure/metrics/prom-client.adapter.js';
import { createMetricsController } from '../../../src/presentation/http/controllers/metrics.controller.js';
import { createHttpMetrics } from '../../../src/infrastructure/metrics/http-metrics.middleware.js';

const TOKEN = 'example-only-not-a-real-metrics-token-0123456789';

/**
 * A small application wired the way the real one is: the collector in front, the endpoint behind a
 * token, and a parameterised route to prove what ends up in the label.
 */
const applicationWith = (metrics: ReturnType<typeof createPromMetrics>): Express => {
  const application = express();
  const controller = createMetricsController({ metrics, token: TOKEN });

  application.use(createHttpMetrics(metrics));
  application.get('/api/v1/tasks/:id', (_request, response) => {
    response.status(200).json({ ok: true });
  });
  application.get('/metrics', controller.render);

  return application;
};

describe('GET /metrics', () => {
  /**
   * 404 rather than 401: an unauthenticated caller learns nothing, not even that the endpoint is
   * mounted here. Same reasoning the API uses for a resource in another organization.
   */
  it.each([
    ['no credential at all', undefined],
    ['a wrong token', 'Bearer not-the-token'],
    ['the token without the scheme', TOKEN],
  ])('answers 404 to %s', async (_case, header) => {
    const call = request(applicationWith(createPromMetrics())).get('/metrics');

    const response = await (header === undefined ? call : call.set('authorization', header));

    expect(response.status).toBe(404);
    expect(response.text).not.toContain('http_requests_total');
  });

  it('answers the exposition text to a caller holding the token', async () => {
    const response = await request(applicationWith(createPromMetrics()))
      .get('/metrics')
      .set('authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.text).toContain('nodejs_eventloop_lag_seconds');
  });
});

describe('what the collector puts in the labels', () => {
  /**
   * The cardinality assertion, made end to end rather than on the adapter alone: two requests to
   * two different task ids must produce **one** series. A metric labelled with the path grows a
   * series per entity, Prometheus never forgets one, and the instance dies of a memory leak with a
   * scrape interval attached.
   */
  it('labels a parameterised route with its template, not the path', async () => {
    const metrics = createPromMetrics();
    const application = applicationWith(metrics);

    await request(application).get('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000');
    await request(application).get('/api/v1/tasks/6ba7b810-9dad-11d1-80b4-00c04fd430c8');

    const rendered = await metrics.render();
    const series = rendered
      .split('\n')
      .filter((line) => line.startsWith('http_requests_total{') && line.includes('/api/v1/tasks'));

    expect(series).toHaveLength(1);
    expect(series[0]).toContain('route="/api/v1/tasks/:id"');
    expect(series[0]).toContain('} 2');
    expect(rendered).not.toContain('550e8400');
  });

  it('records a duration for the same request', async () => {
    const metrics = createPromMetrics();

    await request(applicationWith(metrics)).get('/api/v1/tasks/42');

    await expect(metrics.render()).resolves.toContain(
      'http_request_duration_seconds_count{method="GET",route="/api/v1/tasks/:id"} 1',
    );
  });

  /**
   * The refusal counter, counted where the route template already exists. `429` is the signal
   * because the limiter is the only thing in this application that produces one — asserted rather
   * than assumed, so that a second source of 429 breaks this case instead of quietly widening what
   * the metric means.
   */
  it('counts a refused request under the endpoint that refused it', async () => {
    const metrics = createPromMetrics();
    const application = express();

    application.use(createHttpMetrics(metrics));
    application.post('/api/v1/auth/login', (_request, response) => {
      response.status(429).end();
    });

    await request(application).post('/api/v1/auth/login');

    await expect(metrics.render()).resolves.toContain(
      'auth_rate_limited_total{endpoint="/api/v1/auth/login"} 1',
    );
  });

  it('CONTROL: counts nothing for a request that was not refused', async () => {
    const metrics = createPromMetrics();

    await request(applicationWith(metrics)).get('/api/v1/tasks/42');

    await expect(metrics.render()).resolves.not.toContain('auth_rate_limited_total{endpoint');
  });

  /**
   * CONTROL: an unmatched path must not become a label of its own — that is the other way a metric
   * acquires unbounded cardinality, and the one a scanner probing random URLs finds first.
   */
  it('CONTROL: collapses an unmatched path into a single label', async () => {
    const metrics = createPromMetrics();
    const application = applicationWith(metrics);

    await request(application).get('/no/such/path/one');
    await request(application).get('/no/such/path/two');

    const rendered = await metrics.render();

    expect(rendered).not.toContain('/no/such/path');
  });
});
