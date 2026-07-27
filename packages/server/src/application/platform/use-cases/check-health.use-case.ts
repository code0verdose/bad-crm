import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type HealthProbePort } from '@/application/platform/ports/health-probe.port.js';

export interface HealthResult {
  readonly status: 'alive';
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly checkedAt: Date;
}

/**
 * Liveness of the API process — the reference example of the layering.
 *
 * The path a request takes here is the path every later domain takes:
 * `health.controller.ts` → this use-case → `HealthProbePort` → `process-health.adapter.ts`.
 * Nothing in this file knows that the caller arrived over HTTP, and nothing knows what the adapter
 * is made of, which is why the whole scenario is unit-testable with two objects in memory.
 *
 * The `catch` is not defensive decoration: an adapter is allowed to throw whatever its platform
 * throws, and the boundary where that stops being an infrastructure exception and becomes a domain
 * error is exactly here. Without it a Redis exception would travel to the HTTP layer and be
 * answered `500` with a driver message.
 */
export class CheckHealthUseCase {
  constructor(
    private readonly health: HealthProbePort,
    private readonly clock: ClockPort,
  ) {}

  execute(): Promise<HealthResult> {
    try {
      const snapshot = this.health.snapshot();

      return Promise.resolve({
        status: 'alive',
        version: snapshot.version,
        uptimeSeconds: snapshot.uptimeSeconds,
        checkedAt: this.clock.now(),
      });
    } catch (cause) {
      return Promise.reject(new ServiceUnavailableError({ probe: 'process' }, cause));
    }
  }
}
