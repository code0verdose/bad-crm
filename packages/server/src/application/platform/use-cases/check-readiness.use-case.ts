import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type ProcessLifecyclePort } from '@/application/platform/ports/process-lifecycle.port.js';
import {
  type DependencyReport,
  type ReadinessProbePort,
} from '@/application/platform/ports/readiness-probe.port.js';

export interface ReadinessOptions {
  /**
   * How long one dependency may take before it counts as down.
   *
   * Per dependency, not for the whole check: one stuck service must not hide the state of the
   * others, which is the entire reason the body lists them separately. A service that accepted the
   * connection and then stopped answering is the case this exists for — without a deadline the
   * response stays open, and an orchestrator polling every two seconds accumulates one stuck
   * request per poll.
   */
  readonly probeTimeoutMs: number;
  /**
   * How long a verdict stays fresh.
   *
   * An orchestrator polls this endpoint, and so does every load balancer in front of every
   * instance. Without a cache each poll opens a connection to Postgres, Redis, S3 and Meilisearch —
   * the probe becomes a load generator, and the busier the cluster the more it generates. Two
   * seconds is short enough that a failure is noticed within one polling interval.
   */
  readonly cacheTtlMs: number;
}

export const DEFAULT_READINESS_OPTIONS: ReadinessOptions = {
  probeTimeoutMs: 2000,
  cacheTtlMs: 2000,
};

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
  private cached:
    { readonly reports: readonly [string, DependencyReport][]; readonly at: Date } | undefined;

  constructor(
    private readonly probes: readonly ReadinessProbePort[],
    private readonly lifecycle: ProcessLifecyclePort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly options: ReadinessOptions = DEFAULT_READINESS_OPTIONS,
  ) {}

  async execute(): Promise<ReadinessResult> {
    const checkedAt = this.clock.now();
    const reports = await this.reports(checkedAt);
    // Read on every call, cache or not: shutdown is the one input that changes without any
    // dependency changing, and a cached «ready» would keep sending the load balancer exactly the
    // requests this endpoint exists to divert.
    const shuttingDown = this.lifecycle.isShuttingDown();

    return {
      ready: !shuttingDown && reports.every(([, report]) => report.status !== 'down'),
      shuttingDown,
      dependencies: Object.fromEntries(reports),
      checkedAt,
    };
  }

  private async reports(now: Date): Promise<readonly [string, DependencyReport][]> {
    const fresh =
      this.cached !== undefined &&
      now.getTime() - this.cached.at.getTime() < this.options.cacheTtlMs;

    if (fresh && this.cached !== undefined) return this.cached.reports;

    const reports = await Promise.all(this.probes.map((probe) => this.report(probe)));
    this.cached = { reports, at: now };

    return reports;
  }

  /**
   * The probe, or a verdict of `down` once the deadline passes — whichever comes first.
   *
   * The timer is unreferenced so a pending deadline never holds the event loop open: the process
   * must be able to exit while a probe it has already given up on is still hanging.
   */
  private withTimeout(check: Promise<DependencyReport>): Promise<DependencyReport> {
    return new Promise<DependencyReport>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({ status: 'down', detail: 'timeout' });
      }, this.options.probeTimeoutMs);
      timer.unref?.();

      check.then(
        (report) => {
          clearTimeout(timer);
          resolve(report);
        },
        // Re-thrown as-is, wrapped only when the driver rejected with something that is not an
        // `Error`: `report()` below logs whatever arrives and answers `down`, and replacing the
        // cause here would cost the operator the one copy of the reason.
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private async report(probe: ReadinessProbePort): Promise<[string, DependencyReport]> {
    try {
      return [probe.dependency, await this.withTimeout(probe.check())];
    } catch (error) {
      this.logger.warn({ dependency: probe.dependency, err: error }, 'readiness probe failed');

      return [probe.dependency, { status: 'down' }];
    }
  }
}
