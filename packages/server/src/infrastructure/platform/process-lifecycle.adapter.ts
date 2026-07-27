import { type ProcessLifecyclePort } from '@/application/platform/ports/process-lifecycle.port.js';

/**
 * The readiness flag of the process, shared by the shutdown handler (which sets it) and `/ready`
 * (which reads it through `ProcessLifecyclePort`).
 *
 * One-way on purpose: a process that started stopping never becomes ready again. "Cancel the
 * shutdown" would mean a container that already told the load balancer to drain it starts taking
 * traffic again mid-teardown, with its connection pools half closed.
 */
export class ProcessLifecycleAdapter implements ProcessLifecyclePort {
  private shuttingDown = false;

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }
}
