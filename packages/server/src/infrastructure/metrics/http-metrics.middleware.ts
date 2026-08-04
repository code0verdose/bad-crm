import { type RequestHandler } from 'express';

import { type MetricsPort } from '@/application/platform/ports/metrics.port.js';
import { routeTemplateOf } from '@/infrastructure/logging/route-template.util.js';

/** The only status the rate limiter answers with; see the note at the call site below. */
const TOO_MANY_REQUESTS = 429;

/**
 * Counts every finished request and records how long it took.
 *
 * The route label comes from `routeTemplateOf` — the same function the log line uses, deliberately
 * shared rather than reimplemented. Two answers to «what is this route called» drift, and here the
 * consequences differ in kind: a wrong label in a log is confusing, a wrong label in a metric is one
 * time series per identifier and an instance that runs out of memory.
 *
 * It lives in `infrastructure` beside `http-logger.middleware.ts`, not in `presentation`, and the
 * architecture test is why: a controller may import a port, never an adapter, and this middleware
 * reads `routeTemplateOf` from the logging adapter so that both answers to «what is this route
 * called» come from one function. The first version sat in `presentation/http` and the guard caught
 * it — correctly.
 *
 * Measured on `finish` rather than around `next()`: the handler returns as soon as it has written
 * the response, while the duration an operator cares about ends when the last byte is out.
 * `process.hrtime.bigint()` rather than `Date.now()`, because the wall clock can step backwards and
 * a negative duration in a histogram is a bucket nobody can read.
 */
export const createHttpMetrics = (metrics: MetricsPort): RequestHandler =>
  function collectHttpMetrics(request, response, next) {
    const startedAt = process.hrtime.bigint();

    response.once('finish', () => {
      const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
      const route = routeTemplateOf(request);

      metrics.observeHttpRequest({
        method: request.method,
        route,
        statusCode: response.statusCode,
        durationSeconds: Number(elapsedNanoseconds) / 1e9,
      });

      // A refusal by the rate limiter, counted here rather than in the error handler.
      //
      // Not a choice of taste: the layer test forbids `presentation` from importing anything under
      // `infrastructure`, so the error handler — the other place that knows a request was refused —
      // cannot reach `routeTemplateOf`, and a second hand-written copy of «what is this route
      // called» is exactly the drift the shared helper exists to prevent.
      //
      // `429` is the whole signal because the limiter is the only thing in this application that
      // produces one (`RateLimitedError` → `rate_limited`). A second source of 429 would make this
      // count mean something broader, and the metric would need splitting rather than reinterpreting.
      if (response.statusCode === TOO_MANY_REQUESTS) metrics.incrementAuthRateLimited(route);
    });

    next();
  };
