import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type ProcessLifecycleAdapter } from '@/infrastructure/platform/process-lifecycle.adapter.js';
import { type ShutdownStep } from '@/infrastructure/bootstrap/container.types.js';

/** Logged verbatim when the deadline expires; asserted by the test, greppable in an incident. */
export const FORCED_SHUTDOWN_MESSAGE = 'forced shutdown after timeout';

/** The part of `http.Server` this module uses — narrowed so tests need no real socket. */
export interface ClosableServer {
  close(callback: (error?: Error) => void): unknown;
}

export interface ShutdownOptions {
  readonly server: ClosableServer;
  readonly lifecycle: ProcessLifecycleAdapter;
  readonly steps: readonly ShutdownStep[];
  readonly logger: LoggerPort;
  /** Hard deadline; 30 s in the process (stack.md, «main.ts — composition root и graceful shutdown»). */
  readonly timeoutMs: number;
  readonly exit: (code: number) => void;
}

/**
 * Graceful shutdown: stop taking work, let the work in flight finish, then close what it was using.
 *
 * The order is the whole point, and it is asserted step by step in the test:
 *
 * 1. **Flip the readiness flag first**, synchronously. `/ready` starts answering 503 immediately, so
 *    a load balancer stops routing here while the listener is still winding down. Do this after
 *    `server.close()` and every request that arrives in the gap is accepted by a process that is
 *    about to close its database pool.
 * 2. **`server.close()`** stops accepting new connections but *waits* for the in-flight ones.
 * 3. **Close the resources afterwards** — Prisma, Redis, workers. Closing them earlier is how a
 *    deploy produces a burst of "connection closed" errors in the requests it was supposed to
 *    protect.
 * 4. **Exit 0.**
 *
 * A hard deadline sits over all of it: one stuck handler must not hold a deployment hostage, so
 * after `timeoutMs` the process leaves with code 1 and a line saying why — otherwise the container
 * looks like it crashed on its own.
 *
 * The handler is **idempotent**. `docker stop` sends SIGTERM and then SIGKILL, and an impatient
 * operator presses Ctrl+C twice; a second run would close Prisma underneath the first one.
 *
 * A note on containers, because this is where graceful shutdown usually fails silently: the signal
 * has to reach *this* process. Node receives SIGTERM as PID 1 only because a handler is registered
 * here — an unhandled signal is discarded for PID 1 by the kernel. But a `CMD` in shell form makes
 * `/bin/sh` PID 1, and it forwards nothing: the container then always waits out the full stop
 * timeout and dies by SIGKILL, cutting every in-flight request. The image must use the exec form
 * (`CMD ["node", "dist/main.js"]`) and, for zombie reaping, an init (`init: true` in compose, or
 * `docker run --init`).
 */
export const createShutdownHandler = (options: ShutdownOptions) => {
  let running: Promise<void> | undefined;

  const closeServer = (): Promise<void> =>
    new Promise((resolve) => {
      options.server.close(() => resolve());
    });

  const closeStep = async (step: ShutdownStep): Promise<void> => {
    try {
      await step.close();
    } catch (error) {
      // One resource refusing to close must not strand the others: a Redis connection left open
      // keeps the process alive past the deadline and turns a clean stop into a forced kill.
      options.logger.error({ step: step.name, err: error }, 'shutdown step failed');
    }
  };

  const run = async (signal: string): Promise<void> => {
    options.lifecycle.beginShutdown();
    options.logger.info({ signal }, 'shutdown started');

    const deadline = setTimeout(() => {
      options.logger.error({ signal, timeoutMs: options.timeoutMs }, FORCED_SHUTDOWN_MESSAGE);
      options.exit(1);
    }, options.timeoutMs);

    // Without `unref` the timer itself is a reason for Node to keep running, so a process that
    // finished shutting down would sit idle until the deadline it no longer needs.
    deadline.unref();

    await closeServer();

    for (const step of options.steps) {
      await closeStep(step);
    }

    clearTimeout(deadline);
    options.logger.info({ signal }, 'shutdown complete');
    options.exit(0);
  };

  return (signal: string): Promise<void> => {
    running ??= run(signal);

    return running;
  };
};
