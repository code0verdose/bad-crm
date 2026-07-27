/**
 * State of one dependency.
 *
 * `disabled` is not a degraded `down`: it means this installation switched an optional service off
 * on purpose (no Meilisearch in the `minimal` profile, no SMTP, no AI). It is reported in the body
 * and never changes the HTTP status — otherwise `minimal` would never become ready
 * (rules/observability.mdc, rule 13).
 */
export type DependencyStatus = 'up' | 'down' | 'disabled';

export interface DependencyReport {
  readonly status: DependencyStatus;
  /**
   * Short, non-sensitive explanation chosen by us — a fallback name, not an exception message.
   * Driver errors quote connection strings, and `/ready` is unauthenticated.
   */
  readonly detail?: string;
}

/**
 * One dependency check behind `GET /ready`.
 *
 * Probes are registered in the composition root, so a subsystem that a given installation does not
 * run contributes no probe at all. Postgres and Redis probes arrive with their clients
 * (STORY-003-06, EPIC-009); the port and the aggregation exist now so that adding one is a line in
 * `container.factory.ts` rather than a redesign of the endpoint.
 */
export interface ReadinessProbePort {
  /** Key this dependency appears under in the response body. */
  readonly dependency: string;
  check(): Promise<DependencyReport>;
}
