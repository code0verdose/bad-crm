import { type MetricsPort } from '@/application/platform/ports/metrics.port.js';

/**
 * What the process publishes when `METRICS_ENABLED` is off: nothing, at no cost.
 *
 * A separate adapter rather than a flag checked at every call site. The difference is not style:
 * `collectDefaultMetrics` starts timers that sample the event loop and the heap, and a registry
 * holds every series it has ever seen. An installation that switched metrics off asked for none of
 * that, and «the counter is there but nobody scrapes it» is not the same as off.
 */
export const noopMetrics: MetricsPort = {
  observeHttpRequest: () => undefined,
  incrementAuthRateLimited: () => undefined,
  render: () => Promise.resolve(''),
  contentType: 'text/plain; charset=utf-8',
};
