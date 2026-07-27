import { type HealthResult } from '@/application/platform/use-cases/check-health.use-case.js';
import { type ReadinessResult } from '@/application/platform/use-cases/check-readiness.use-case.js';

export interface HealthResponse {
  readonly status: 'alive';
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly checkedAt: string;
}

export interface ReadinessResponse {
  readonly ready: boolean;
  readonly shuttingDown: boolean;
  readonly dependencies: Readonly<Record<string, { status: string; detail?: string }>>;
  readonly checkedAt: string;
}

/**
 * Use-case result → response body.
 *
 * The controller never assembles a body out of pieces: the serializer is the one place where the
 * wire shape is decided, so it is also the one place the OpenAPI document has to agree with
 * (STORY-003-05). `Date` becomes an ISO string here — JSON has no date type, and letting
 * `JSON.stringify` do it implicitly means the format is decided by whoever happens to serialize.
 */
export const serializeHealth = (result: HealthResult): HealthResponse => ({
  status: result.status,
  version: result.version,
  uptimeSeconds: result.uptimeSeconds,
  checkedAt: result.checkedAt.toISOString(),
});

export const serializeReadiness = (result: ReadinessResult): ReadinessResponse => ({
  ready: result.ready,
  shuttingDown: result.shuttingDown,
  dependencies: result.dependencies,
  checkedAt: result.checkedAt.toISOString(),
});
