import { describe, expect, it } from 'vitest';

import { CheckReadinessUseCase } from '../../../src/application/platform/use-cases/check-readiness.use-case.js';
import type { ClockPort } from '../../../src/application/platform/ports/clock.port.js';
import type { LogFields, LoggerPort } from '../../../src/application/platform/ports/logger.port.js';
import type { ProcessLifecyclePort } from '../../../src/application/platform/ports/process-lifecycle.port.js';
import type {
  DependencyReport,
  ReadinessProbePort,
} from '../../../src/application/platform/ports/readiness-probe.port.js';

const FIXED_NOW = new Date('2026-07-27T10:00:00.000Z');
const fixedClock: ClockPort = { now: () => FIXED_NOW };

const running: ProcessLifecyclePort = { isShuttingDown: () => false };
const stopping: ProcessLifecyclePort = { isShuttingDown: () => true };

const probe = (dependency: string, report: DependencyReport): ReadinessProbePort => ({
  dependency,
  check: () => Promise.resolve(report),
});

const throwingProbe = (dependency: string, cause: Error): ReadinessProbePort => ({
  dependency,
  check: () => Promise.reject(cause),
});

interface RecordedLog {
  readonly fields: LogFields;
  readonly message: string;
}

/** In-memory logger: the recorded lines are asserted as data, not as "was it called". */
const recordingLogger = (): { logger: LoggerPort; warnings: RecordedLog[] } => {
  const warnings: RecordedLog[] = [];
  const logger: LoggerPort = {
    debug: () => undefined,
    info: () => undefined,
    warn: (fields, message) => warnings.push({ fields, message }),
    error: () => undefined,
    child: () => logger,
  };

  return { logger, warnings };
};

describe('CheckReadinessUseCase', () => {
  it('is ready when every dependency answers and the process is not stopping', async () => {
    const { logger } = recordingLogger();
    const useCase = new CheckReadinessUseCase(
      [probe('postgres', { status: 'up' }), probe('redis', { status: 'up' })],
      running,
      fixedClock,
      logger,
    );

    await expect(useCase.execute()).resolves.toEqual({
      ready: true,
      shuttingDown: false,
      checkedAt: FIXED_NOW,
      dependencies: { postgres: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('is not ready while a dependency is down', async () => {
    const { logger } = recordingLogger();
    const useCase = new CheckReadinessUseCase(
      [probe('postgres', { status: 'up' }), probe('redis', { status: 'down' })],
      running,
      fixedClock,
      logger,
    );

    await expect(useCase.execute()).resolves.toMatchObject({ ready: false });
  });

  /**
   * `rules/observability.mdc`, rule 13: an optional service that this installation switched off is
   * reported in the body and does not change the verdict. Tie readiness to Meilisearch and the
   * `minimal` profile — which ships without it on purpose — never becomes ready, so the load
   * balancer never sends it traffic.
   */
  it('stays ready when an optional service is disabled, and says so in the body', async () => {
    const { logger } = recordingLogger();
    const useCase = new CheckReadinessUseCase(
      [
        probe('postgres', { status: 'up' }),
        probe('search', { status: 'disabled', detail: 'postgres-fts' }),
      ],
      running,
      fixedClock,
      logger,
    );

    await expect(useCase.execute()).resolves.toEqual({
      ready: true,
      shuttingDown: false,
      checkedAt: FIXED_NOW,
      dependencies: {
        postgres: { status: 'up' },
        search: { status: 'disabled', detail: 'postgres-fts' },
      },
    });
  });

  it('stops being ready the moment shutdown begins, even with every dependency up', async () => {
    const { logger } = recordingLogger();
    const useCase = new CheckReadinessUseCase(
      [probe('postgres', { status: 'up' })],
      stopping,
      fixedClock,
      logger,
    );

    await expect(useCase.execute()).resolves.toMatchObject({ ready: false, shuttingDown: true });
  });

  /**
   * A driver failure message routinely contains the connection string, and a connection string
   * contains the password. `/ready` is reachable without authentication (rules/security.mdc,
   * "Исключения"), so the failure goes to the log and the body says nothing but `down`.
   */
  it('reports a throwing probe as down without putting the exception into the response', async () => {
    const { logger, warnings } = recordingLogger();
    const cause = new Error('password authentication failed for user "app_user" (hunter2)');
    const useCase = new CheckReadinessUseCase(
      [throwingProbe('postgres', cause)],
      running,
      fixedClock,
      logger,
    );

    const result = await useCase.execute();

    expect(result.ready).toBe(false);
    expect(result.dependencies['postgres']).toEqual({ status: 'down' });
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({ dependency: 'postgres', err: cause });
  });

  it('answers with no dependencies registered rather than pretending to be unready', async () => {
    const { logger } = recordingLogger();
    const useCase = new CheckReadinessUseCase([], running, fixedClock, logger);

    await expect(useCase.execute()).resolves.toEqual({
      ready: true,
      shuttingDown: false,
      checkedAt: FIXED_NOW,
      dependencies: {},
    });
  });
});
