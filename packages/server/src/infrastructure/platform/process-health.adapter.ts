import {
  type HealthProbePort,
  type ProcessHealthSnapshot,
} from '@/application/platform/ports/health-probe.port.js';

/**
 * `HealthProbePort` on the Node process itself.
 *
 * Nothing here can block or fail: liveness answers "is this process still running", and a probe
 * that waited on a dependency would let a slow query look like a hung container and get it
 * restarted — during exactly the incident where restarts make things worse.
 */
export class ProcessHealthAdapter implements HealthProbePort {
  constructor(
    private readonly version: string,
    private readonly uptimeSeconds: () => number = () => process.uptime(),
  ) {}

  snapshot(): ProcessHealthSnapshot {
    return { uptimeSeconds: Math.round(this.uptimeSeconds()), version: this.version };
  }
}
