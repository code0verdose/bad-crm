import { type ReadinessProbePort } from '@/application/platform/ports/readiness-probe.port.js';
import { describeDegradations } from '@/infrastructure/bootstrap/env-features.util.js';
import { type ServerEnv } from '@/infrastructure/bootstrap/env.schema.js';

/**
 * Readiness probes for the optional services this installation is **not** running.
 *
 * The application is required to start without Meilisearch, without SMTP, without AI and without an
 * OTel collector (stack.md, «Деградация при отсутствии опционального сервиса»). Since it starts
 * anyway, the only way an operator learns that search is running on PostgreSQL FTS is by asking
 * `/ready` — which is why a switched-off service is reported as `disabled` with its fallback
 * instead of being omitted.
 *
 * `disabled` never changes the HTTP status (rules/observability.mdc, rule 13): tie readiness to an
 * optional service and the `minimal` profile — which ships without it deliberately — never becomes
 * ready, so the load balancer never sends it a request.
 *
 * A service that *is* configured gets no probe here; its live check arrives with its client
 * (Postgres in STORY-003-06, Redis and Meilisearch in EPIC-009) and is registered in
 * `container.factory.ts` alongside these.
 */
export const optionalServiceProbes = (env: ServerEnv): readonly ReadinessProbePort[] =>
  describeDegradations(env).map(({ feature, fallback }) => ({
    dependency: feature,
    check: () => Promise.resolve({ status: 'disabled' as const, detail: fallback }),
  }));
