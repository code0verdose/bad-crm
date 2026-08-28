import { type SharedPermissions } from '@bad-crm/shared';

/** One finished HTTP request, as the metrics layer sees it. */
export interface HttpRequestObservation {
  readonly method: string;
  /**
   * The route **template** (`/api/v1/tasks/:id`), never the path that was requested.
   *
   * A label carrying an identifier gives Prometheus one time series per entity, and a series is
   * never forgotten — a week of task pages turns a counter into tens of thousands of series and
   * takes the instance down with it. The template is also the only form that is safe to publish:
   * `/metrics` has no user in it, and an identifier in a label is a user's data in a place designed
   * to be scraped by anything on the network.
   */
  readonly route: string;
  readonly statusCode: number;
  readonly durationSeconds: number;
}

/**
 * What the process publishes about itself.
 *
 * A port rather than a direct `prom-client` call, for the same reason the logger is one: the
 * application layer states *what* is worth counting, and only `infrastructure` knows the library
 * that counts it. It also makes «metrics are switched off» a different adapter rather than an `if`
 * at every call site.
 */
export interface MetricsPort {
  observeHttpRequest(observation: HttpRequestObservation): void;
  /** A refused sign-in attempt, by the endpoint that refused it. */
  incrementAuthRateLimited(endpoint: string): void;
  /**
   * One refusal by the permission layer, by the reason it was refused for.
   *
   * The reason is the whole value of the counter, and it is what an operator of a self-hosted
   * installation has instead of a support team: `permission_not_granted` spread across an
   * organization is a role that needs widening, while `tenant_mismatch` climbing on one instance is
   * somebody walking identifiers. Both answer with a status the RED set already counts, and
   * `tenant_mismatch` deliberately answers **404** — so without this label the two are one number.
   *
   * `DenyReason` rather than a string: the set is closed and enumerated in `packages/shared`, which
   * is what makes the label safe. Nothing identifying goes beside it — no user, no organization, no
   * path with an id in it. `/metrics` is read by whatever reaches the port, and one series per
   * identifier is a memory leak with a scrape interval attached.
   */
  incrementPermissionDenied(reason: SharedPermissions.DenyReason): void;
  /**
   * One privileged action that could not be written to the trail.
   *
   * Unlabelled on purpose. The tempting label is the action, and it is the wrong one twice over: the
   * catalogue grows with every epic, so the series count grows with it, and the question this metric
   * exists to answer — «is the trail writing at all» — needs none of them. Which event failed is in
   * the log line the caller's own failure produces.
   *
   * It reports; it does not soften. A failed write still fails the transaction that caused it
   * (`audit-logger.port.ts`: an action nobody could write down did not happen). What changes is that
   * an operator learns of it from a series they can alert on instead of from a request that failed
   * and looked like every other failed request.
   */
  incrementAuditWriteFailed(): void;
  /** The exposition format, rendered on demand. */
  render(): Promise<string>;
  readonly contentType: string;
}
