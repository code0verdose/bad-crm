import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type ProcessLifecyclePort } from '@/application/platform/ports/process-lifecycle.port.js';
import {
  type DependencyReport,
  type ReadinessProbePort,
} from '@/application/platform/ports/readiness-probe.port.js';

export interface ReadinessResult {
  readonly ready: boolean;
  readonly shuttingDown: boolean;
  readonly dependencies: Readonly<Record<string, DependencyReport>>;
  readonly checkedAt: Date;
}

/**
 * Readiness of the API process: may this instance receive traffic right now?
 *
 * Two things decide it, and both are policy rather than transport, which is why they live here and
 * not in the controller:
 *
 * - **Shutdown wins over everything.** Once the process starts stopping, it is not ready even
 *   though every dependency is still up — that is how in-flight requests get to finish while the
 *   load balancer stops sending new ones.
 * - **`disabled` is not `down`.** An optional service switched off by configuration is reported and
 *   ignored in the verdict; otherwise the `minimal` profile, which ships without Meilisearch on
 *   purpose, would never become ready (rules/observability.mdc, rule 13).
 *
 * A probe that throws is treated as `down` and its exception goes to the log, never to the body:
 * `/ready` is unauthenticated, and driver failures quote connection strings that contain passwords.
 */
export class CheckReadinessUseCase {
  constructor(
    private readonly probes: readonly ReadinessProbePort[],
    private readonly lifecycle: ProcessLifecyclePort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
  ) {}

  async execute(): Promise<ReadinessResult> {
    const reports = await Promise.all(this.probes.map((probe) => this.report(probe)));
    const shuttingDown = this.lifecycle.isShuttingDown();

    return {
      ready: !shuttingDown && reports.every(([, report]) => report.status !== 'down'),
      shuttingDown,
      dependencies: Object.fromEntries(reports),
      checkedAt: this.clock.now(),
    };
  }

  private async report(probe: ReadinessProbePort): Promise<[string, DependencyReport]> {
    try {
      return [probe.dependency, await probe.check()];
    } catch (error) {
      this.logger.warn({ dependency: probe.dependency, err: error }, 'readiness probe failed');

      return [probe.dependency, { status: 'down' }];
    }
  }
}
