import { type SharedPermissions } from '@bad-crm/shared';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

import {
  type Argon2Refusal,
  type HttpRequestObservation,
  type MetricsPort,
} from '@/application/platform/ports/metrics.port.js';
import { cachedReading } from '@/infrastructure/metrics/cached-reading.util.js';

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
/**
 * How stale `audit_log_partition_bytes` may be, and why a minute is the right order of magnitude.
 *
 * The journal grows by single-digit megabytes a month for an installation of fifty people
 * (`docs/runbooks/audit-log.md`), so a value a minute old differs from a fresh one by an amount no
 * threshold can distinguish. What the window buys is the other side: the reading is a catalogue
 * query against the database that serves requests, and without it its frequency would be decided by
 * whoever is scraping — two Prometheus servers at 15 s, or a dashboard on a refresh loop.
 */
const AUDIT_LOG_SIZE_MAX_AGE_MS = 60_000;

export interface PromMetricsOptions {
  /**
   * Where the size of the audit trail is read from, when this installation can read it.
   *
   * Optional so the adapter stays constructible without a database — the unit suites build it that
   * way, and an installation with metrics on but no reader simply publishes one series fewer,
   * rather than publishing zero bytes of audit trail, which is a different and untrue claim.
   */
  readonly readAuditLogBytes?: () => Promise<number>;
}

export const createPromMetrics = ({ readAuditLogBytes }: PromMetricsOptions = {}): MetricsPort => {
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

  const permissionDenied = new Counter({
    name: 'permission_denied_total',
    help: 'Refusals by the permission layer, by the reason they were refused for.',
    labelNames: ['reason'] as const,
    registers: [registry],
  });

  const auditWriteFailed = new Counter({
    name: 'audit_write_failed_total',
    help: 'Privileged actions that could not be written to the audit trail.',
    registers: [registry],
  });

  const auditUnscoped = new Counter({
    name: 'audit_unscoped_total',
    help: 'Privileged actions recorded as a log line because they have no organization to be filed under.',
    registers: [registry],
  });

  const mfaRecoveryFailed = new Counter({
    name: 'mfa_recovery_failed_total',
    help: 'Recovery codes presented at the second-factor step and refused.',
    registers: [registry],
  });

  const argon2InFlight = new Gauge({
    name: 'argon2_inflight',
    help: 'Argon2id computations running right now, against the configured ceiling.',
    registers: [registry],
  });

  const argon2Queued = new Gauge({
    name: 'argon2_queued',
    help: 'Computations waiting for one of those slots right now, against the derived queue bound.',
    registers: [registry],
  });

  // A counter beside the two gauges, and not a third gauge: gauges are sampled, and a burst shorter
  // than the scrape interval leaves both of them reading zero. See `incrementArgon2Refused`.
  const argon2Refused = new Counter({
    name: 'argon2_refused_total',
    help: 'Requests the argon2 ceiling turned away, by the rule that turned them away.',
    labelNames: ['refusal'] as const,
    registers: [registry],
  });

  /**
   * The size of the audit trail on disk — the one series here that is *pulled* rather than pushed.
   *
   * **No label, and the tempting one is the partition.** A per-month label would answer «which month
   * is big», at the price of a new time series every month for the life of the installation, one
   * that goes flat the day its month ends and is never removed — the unbounded-label rule of
   * `rules/observability.mdc` §9, arriving on a slow clock instead of a fast one. It would also
   * answer the operator's actual questions worse: «how fast is it growing» and «will the disk last»
   * are `rate()` and `predict_linear()` over one continuous series, and neither survives being
   * chopped into a new series every month. Which partition is large is a question asked once, after
   * the alert, with the query already written in `docs/runbooks/audit-log.md`.
   *
   * The reading is behind {@link cachedReading}: `collect` runs on the scraper's schedule, and a
   * database query on somebody else's schedule is not a schedule at all.
   */
  if (readAuditLogBytes !== undefined) {
    const reading = cachedReading({
      read: readAuditLogBytes,
      maxAgeMs: AUDIT_LOG_SIZE_MAX_AGE_MS,
    });

    new Gauge({
      name: 'audit_log_partition_bytes',
      help: 'Disk occupied by the audit trail: every partition of audit_logs with its indexes.',
      registers: [registry],
      collect: async function collectAuditLogBytes(): Promise<void> {
        const bytes = await reading();

        if (bytes === undefined) {
          // `remove()` rather than leaving it alone: a `Gauge` is born holding zero and renders that
          // zero whether or not anything ever set it, so an installation whose first reading failed
          // would publish «the audit trail occupies no disk» — a false claim, and the one that reads
          // as reassuring. Nothing at all is the honest exposition, and a scrape after the database
          // comes back brings the series with it.
          this.remove();

          return;
        }

        this.set(bytes);
      },
    });
  }

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
    incrementPermissionDenied: (reason: SharedPermissions.DenyReason): void => {
      permissionDenied.inc({ reason });
    },
    incrementAuditWriteFailed: (): void => {
      auditWriteFailed.inc();
    },
    incrementAuditUnscoped: (): void => {
      auditUnscoped.inc();
    },
    incrementMfaRecoveryFailed: (): void => {
      mfaRecoveryFailed.inc();
    },
    setArgon2InFlight: (inFlight: number): void => {
      argon2InFlight.set(inFlight);
    },
    setArgon2Queued: (queued: number): void => {
      argon2Queued.set(queued);
    },
    incrementArgon2Refused: (refusal: Argon2Refusal): void => {
      argon2Refused.inc({ refusal });
    },
    render: () => registry.metrics(),
    contentType: registry.contentType,
  };
};
