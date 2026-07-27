/** What the process can say about itself without asking anybody else. */
export interface ProcessHealthSnapshot {
  /** Seconds since this process started. */
  readonly uptimeSeconds: number;
  /** Version of the running build, so a `/health` response identifies what is deployed. */
  readonly version: string;
}

/**
 * Liveness source for `GET /health`.
 *
 * Deliberately narrow: liveness answers "is this process still running", and a probe that reached
 * for the database would make a slow query look like a dead container and get it restarted
 * (rules/observability.mdc, rule 13). Dependencies belong to `ReadinessProbePort`.
 */
export interface HealthProbePort {
  snapshot(): ProcessHealthSnapshot;
}
