import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

import {
  type HttpRequestObservation,
  type MetricsPort,
} from '@/application/platform/ports/metrics.port.js';

/**
 * Buckets for an API, not for a batch job.
 *
 * Chosen around the latency targets in `docs/product/prd.md` rather than left at the library
 * default: the default set stops at 10 s, which puts every interesting request into one bucket and
 * makes a p95 unanswerable. The tail above 2 s exists because a request that slow is the one an
 * operator is looking for.
 */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];

/**
 * The process, described in the exposition format.
 *
 * **Its own registry, never the global default.** `prom-client` exports a module-level registry, and
 * two adapters sharing it would make one instance's counts appear in another's output — invisible
 * in production, and in tests an order-dependent failure that gets debugged by rerunning rather
 * than by reading.
 *
 * Labels carry a method, a route **template** and a status, and nothing else. `/metrics` is scraped
 * by whatever can reach it, so an identifier in a label is a user's data published by design; and
 * one series per identifier is a memory leak with a scrape interval attached.
 */
export const createPromMetrics = (): MetricsPort => {
  const registry = new Registry();

  collectDefaultMetrics({ register: registry });

  const requests = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests by method, route template and status code.',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });

  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds, by method and route template.',
    labelNames: ['method', 'route'] as const,
    buckets: DURATION_BUCKETS,
    registers: [registry],
  });

  const authRateLimited = new Counter({
    name: 'auth_rate_limited_total',
    help: 'Sign-in attempts refused by the rate limiter, by endpoint.',
    labelNames: ['endpoint'] as const,
    registers: [registry],
  });

  return {
    observeHttpRequest: ({
      method,
      route,
      statusCode,
      durationSeconds,
    }: HttpRequestObservation): void => {
      requests.inc({ method, route, status: String(statusCode) });
      duration.observe({ method, route }, durationSeconds);
    },
    incrementAuthRateLimited: (endpoint: string): void => {
      authRateLimited.inc({ endpoint });
    },
    render: () => registry.metrics(),
    contentType: registry.contentType,
  };
};
