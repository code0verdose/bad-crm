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
  /** The exposition format, rendered on demand. */
  render(): Promise<string>;
  readonly contentType: string;
}
