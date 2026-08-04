import { describe, expect, it } from 'vitest';

import { noopMetrics } from '../../../src/infrastructure/metrics/noop-metrics.adapter.js';
import { createPromMetrics } from '../../../src/infrastructure/metrics/prom-client.adapter.js';

/**
 * The exposition text is the contract — a scraper reads it, not this code — so the assertions are
 * on the rendered output rather than on «was the counter called». Same reason the redaction tests
 * assert bytes: a mock records intent, and intent is not what leaves the process.
 */
describe('the prom-client adapter', () => {
  it('counts a request by method, route and status', async () => {
    const metrics = createPromMetrics();

    metrics.observeHttpRequest({
      method: 'GET',
      route: '/api/v1/tasks/:id',
      statusCode: 200,
      durationSeconds: 0.012,
    });

    await expect(metrics.render()).resolves.toContain(
      'http_requests_total{method="GET",route="/api/v1/tasks/:id",status="200"} 1',
    );
  });

  it('records the duration as a histogram under the same route label', async () => {
    const metrics = createPromMetrics();

    metrics.observeHttpRequest({
      method: 'GET',
      route: '/api/v1/meta',
      statusCode: 200,
      durationSeconds: 0.3,
    });

    const rendered = await metrics.render();

    expect(rendered).toContain('http_request_duration_seconds_bucket');
    expect(rendered).toContain('route="/api/v1/meta"');
  });

  /**
   * The label that decides whether this endpoint is useful or fatal. One series per task id is a
   * memory leak with a scrape interval attached, and Prometheus never forgets a series it has seen.
   */
  it('keeps two ids under one template in a single series', async () => {
    const metrics = createPromMetrics();

    for (let call = 0; call < 3; call += 1) {
      metrics.observeHttpRequest({
        method: 'GET',
        route: '/api/v1/tasks/:id',
        statusCode: 200,
        durationSeconds: 0.01,
      });
    }

    const series = (await metrics.render())
      .split('\n')
      .filter((line) => line.startsWith('http_requests_total{') && line.includes('/api/v1/tasks'));

    expect(series).toHaveLength(1);
    expect(series[0]).toContain('} 3');
  });

  it('counts a rate-limited sign-in by the endpoint that refused it', async () => {
    const metrics = createPromMetrics();

    metrics.incrementAuthRateLimited('/api/v1/auth/login');

    await expect(metrics.render()).resolves.toContain(
      'auth_rate_limited_total{endpoint="/api/v1/auth/login"} 1',
    );
  });

  /** Heap, event-loop lag and GC — the numbers an operator looks at before ours. */
  it('publishes the default Node metrics', async () => {
    const rendered = await createPromMetrics().render();

    expect(rendered).toContain('nodejs_eventloop_lag_seconds');
    expect(rendered).toContain('process_resident_memory_bytes');
  });

  /**
   * CONTROL: two adapters must not share a registry. The default `prom-client` registry is global,
   * and using it would make every count depend on which test ran first — the order-dependent
   * failure that gets debugged by rerunning rather than by reading.
   */
  it('CONTROL: gives each instance its own registry', async () => {
    const first = createPromMetrics();
    const second = createPromMetrics();

    first.incrementAuthRateLimited('/api/v1/auth/login');

    await expect(second.render()).resolves.not.toContain('auth_rate_limited_total{endpoint');
  });
});

/**
 * `METRICS_ENABLED=false` has to cost nothing rather than «cost less»: no registry, no default
 * collectors sampling the event loop every scrape, no exposition text held in memory.
 */
describe('metrics switched off', () => {
  it('records nothing and renders nothing', async () => {
    noopMetrics.observeHttpRequest({
      method: 'GET',
      route: '/api/v1/meta',
      statusCode: 200,
      durationSeconds: 1,
    });
    noopMetrics.incrementAuthRateLimited('/api/v1/auth/login');

    await expect(noopMetrics.render()).resolves.toBe('');
  });
});
