/**
 * Vocabulary shared by `scripts/check-services.ts` and `scripts/preflight.ts`.
 *
 * A check is a question asked of a running service, not a container status. `docker compose ps`
 * answers "the process is up"; these answer "the application can use it" — which is a different
 * question the day Postgres is healthy but `app_user` does not exist.
 */

export type CheckStatus = 'ok' | 'failed' | 'skipped';

/**
 * `required` — the application cannot start without it (Postgres, Redis, S3).
 * `optional` — the application degrades and keeps working (Meilisearch, SMTP), see
 * `stack.md`, «Деградация при отсутствии опционального сервиса». Only a required failure is
 * allowed to fail the command.
 */
export type CheckRequirement = 'required' | 'optional';

export interface CheckOutcome {
  readonly status: CheckStatus;
  /** What was verified, in the operator's words. Never contains a secret. */
  readonly details: readonly string[];
  /** The next step. Present whenever `status` is not `ok`, absent otherwise. */
  readonly remedy?: string;
}

export interface ServiceCheck {
  /** Lower-case service name as it appears in `docker-compose.yml`. */
  readonly service: string;
  readonly requirement: CheckRequirement;
  /** `host:port` or a URL with the password already removed — printed verbatim. */
  readonly target: string;
  run(): Promise<CheckOutcome>;
}

export interface CheckResult extends CheckOutcome {
  readonly service: string;
  readonly requirement: CheckRequirement;
  readonly target: string;
  readonly durationMs: number;
}
