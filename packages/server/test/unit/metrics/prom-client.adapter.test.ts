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
   * A gauge, not a counter: the question `argon2_inflight` answers is «how many 19 MiB allocations
   * exist right now», and a monotonic total cannot answer it. Saturation held at the ceiling is the
   * shape of a credential-stuffing run, and it is the warning an operator gets before the OOM
   * killer picks a process (STORY-013-06, acceptance 4).
   */
  it('publishes the number of argon2 computations in flight, and lets it fall', async () => {
    const metrics = createPromMetrics();

    metrics.setArgon2InFlight(3);

    await expect(metrics.render()).resolves.toContain('argon2_inflight 3');

    metrics.setArgon2InFlight(0);

    await expect(metrics.render()).resolves.toContain('argon2_inflight 0');
  });

  /**
   * The second half of the same picture. `argon2_inflight` stops moving once the ceiling is reached
   * — four of four reads identically with one request waiting behind it and with five hundred — so
   * it cannot say how deep the saturation is, which is the number that separates a busy minute from
   * a flood and says how close the queue is to shedding load it could have served.
   */
  it('publishes how many computations are waiting for a slot, and lets it fall', async () => {
    const metrics = createPromMetrics();

    metrics.setArgon2Queued(17);

    await expect(metrics.render()).resolves.toContain('argon2_queued 17');

    metrics.setArgon2Queued(0);

    await expect(metrics.render()).resolves.toContain('argon2_queued 0');
  });

  /**
   * The one thing neither gauge can answer: **how many** sign-ins were refused.
   *
   * Both gauges are sampled, and a refusal is an event — a burst that opens and closes between two
   * scrapes leaves both of them reading zero, so «argon2_queued > 0 for a minute» (hosting.md §9.1,
   * signal 13) is unfirable for exactly the spikes that turn users away. `http_requests_total`
   * cannot stand in either: its `503` bucket mixes these with the refusal an unreachable Redis
   * raises, which is a different fault with a different remedy.
   *
   * Two label values, both from a closed union, and nothing identifying beside them.
   */
  it('counts each refusal by the rule that made it', async () => {
    const metrics = createPromMetrics();

    metrics.incrementArgon2Refused('queue_full');
    metrics.incrementArgon2Refused('wait_expired');
    metrics.incrementArgon2Refused('wait_expired');

    const rendered = await metrics.render();

    expect(rendered).toContain('argon2_refused_total{refusal="queue_full"} 1');
    expect(rendered).toContain('argon2_refused_total{refusal="wait_expired"} 2');
  });

  it('declares the gauge without labels, so it cannot grow a series per caller', async () => {
    const metrics = createPromMetrics();

    metrics.setArgon2InFlight(1);

    const rendered = await metrics.render();

    expect(rendered).toContain('# TYPE argon2_inflight gauge');
    expect(rendered).not.toMatch(/argon2_inflight\{/);
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
    noopMetrics.incrementPermissionDenied('permission_not_granted');
    noopMetrics.incrementAuditWriteFailed();
    noopMetrics.setArgon2InFlight(4);
    noopMetrics.setArgon2Queued(2);
    noopMetrics.incrementAuditUnscoped();
    noopMetrics.incrementMfaRecoveryFailed();
    noopMetrics.incrementArgon2Refused('queue_full');

    await expect(noopMetrics.render()).resolves.toBe('');
  });
});
