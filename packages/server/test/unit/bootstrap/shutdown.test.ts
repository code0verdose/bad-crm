import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProcessLifecycleAdapter } from '../../../src/infrastructure/platform/process-lifecycle.adapter.js';
import {
  FORCED_SHUTDOWN_MESSAGE,
  createShutdownHandler,
} from '../../../src/infrastructure/bootstrap/shutdown.factory.js';
import type { LogFields, LoggerPort } from '../../../src/application/platform/ports/logger.port.js';

interface RecordedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly fields: LogFields;
  readonly message: string;
}

const recordingLogger = (): { logger: LoggerPort; lines: RecordedLine[] } => {
  const lines: RecordedLine[] = [];
  const record =
    (level: RecordedLine['level']) =>
    (fields: LogFields, message: string): void => {
      lines.push({ level, fields, message });
    };
  const logger: LoggerPort = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };

  return { logger, lines };
};

/** Stand-in for `http.Server`: `close` reports back only once the in-flight request is done. */
const fakeServer = (): { close: (callback: () => void) => void; finishInFlight: () => void } => {
  let pending: (() => void) | undefined;

  return {
    close: (callback) => {
      pending = callback;
    },
    finishInFlight: () => pending?.(),
  };
};

const orderedShutdown = () => {
  const order: string[] = [];
  const server = fakeServer();
  const lifecycle = new ProcessLifecycleAdapter();
  const { logger, lines } = recordingLogger();
  const exitCodes: number[] = [];

  const shutdown = createShutdownHandler({
    server: {
      close: (callback) => {
        order.push('server.close');
        server.close(callback);
      },
    },
    lifecycle,
    steps: [
      {
        name: 'prisma',
        close: () => {
          order.push('prisma.close');
        },
      },
      {
        name: 'redis',
        close: () => {
          order.push('redis.close');
        },
      },
    ],
    logger,
    timeoutMs: 30_000,
    exit: (code) => exitCodes.push(code),
  });

  return { shutdown, server, lifecycle, order, lines, exitCodes };
};

describe('graceful shutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops advertising readiness before it stops accepting connections', async () => {
    const { shutdown, server, lifecycle, order } = orderedShutdown();

    const finished = shutdown('SIGTERM');
    // The flag flips synchronously: a request that arrives in the gap must already be told to go
    // elsewhere, otherwise the load balancer keeps routing here while the listener winds down.
    expect(lifecycle.isShuttingDown()).toBe(true);
    expect(order).toEqual(['server.close']);

    server.finishInFlight();
    await finished;

    expect(order).toEqual(['server.close', 'prisma.close', 'redis.close']);
  });

  it('lets an in-flight request finish before closing the resources it may still use', async () => {
    const { shutdown, server, order } = orderedShutdown();

    const finished = shutdown('SIGTERM');

    // With the request still running, nothing has been torn down under it.
    expect(order).toEqual(['server.close']);

    server.finishInFlight();
    await finished;

    expect(order).toContain('prisma.close');
  });

  it('exits with code 0 once everything is closed', async () => {
    const { shutdown, server, exitCodes } = orderedShutdown();

    const finished = shutdown('SIGTERM');
    server.finishInFlight();
    await finished;

    expect(exitCodes).toEqual([0]);
  });

  /**
   * A worker stuck on a network call must not hold a deployment hostage: after the hard timeout the
   * process leaves with a non-zero code, and the log says why — otherwise the container looks like
   * it crashed for no reason (stack.md, «main.ts — composition root и graceful shutdown»).
   */
  it('forces the exit after the timeout, with an explanation in the log', async () => {
    const { shutdown, lines, exitCodes } = orderedShutdown();

    void shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(exitCodes).toEqual([1]);
    expect(lines.map((line) => line.message)).toContain(FORCED_SHUTDOWN_MESSAGE);
  });

  it('does not force the exit when the shutdown finished in time', async () => {
    const { shutdown, server, exitCodes } = orderedShutdown();

    const finished = shutdown('SIGTERM');
    server.finishInFlight();
    await finished;

    await vi.advanceTimersByTimeAsync(60_000);

    expect(exitCodes).toEqual([0]);
  });

  /**
   * `docker stop` sends SIGTERM and then SIGKILL, and an impatient operator sends Ctrl+C twice. A
   * second run would close Prisma while the first run is still using it, which surfaces as
   * "connection closed" errors in the last requests of a deploy — the exact noise graceful
   * shutdown exists to remove.
   */
  it('ignores a repeated signal instead of tearing everything down twice', async () => {
    const { shutdown, server, order } = orderedShutdown();

    const first = shutdown('SIGTERM');
    const second = shutdown('SIGINT');

    server.finishInFlight();
    await Promise.all([first, second]);

    expect(order).toEqual(['server.close', 'prisma.close', 'redis.close']);
  });

  it('keeps closing the remaining resources when one of them fails', async () => {
    const order: string[] = [];
    const server = fakeServer();
    const { logger, lines } = recordingLogger();
    const exitCodes: number[] = [];

    const shutdown = createShutdownHandler({
      server,
      lifecycle: new ProcessLifecycleAdapter(),
      steps: [
        {
          name: 'prisma',
          close: () => Promise.reject(new Error('pool already closed')),
        },
        {
          name: 'redis',
          close: () => {
            order.push('redis.close');
          },
        },
      ],
      logger,
      timeoutMs: 30_000,
      exit: (code) => exitCodes.push(code),
    });

    const finished = shutdown('SIGTERM');
    server.finishInFlight();
    await finished;

    expect(order).toEqual(['redis.close']);
    expect(exitCodes).toEqual([0]);
    expect(lines.filter((line) => line.level === 'error')).toHaveLength(1);
  });
});
