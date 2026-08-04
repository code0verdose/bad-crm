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

/**
 * A dependency that never answers, and a clock that can be moved — the two things the probe has to
 * survive.
 *
 * A hung service is not a hypothetical: a Meilisearch that accepted the TCP connection and then
 * stopped answering keeps `/ready` open until something else gives up, and an orchestrator polling
 * every two seconds accumulates one stuck request per poll. The verdict «this dependency did not
 * answer in time» is available immediately and is the honest one.
 */
const neverAnsweringProbe = (dependency: string): ReadinessProbePort => ({
  dependency,
  check: () => new Promise<DependencyReport>(() => undefined),
});

const movableClock = (start: Date) => {
  let current = start;

  return {
    clock: { now: () => current } satisfies ClockPort,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
};

const countingProbe = (dependency: string, report: DependencyReport) => {
  let calls = 0;

  return {
    probe: {
      dependency,
      check: () => {
        calls += 1;
        return Promise.resolve(report);
      },
    } satisfies ReadinessProbePort,
    calls: () => calls,
  };
};

describe('a dependency that does not answer', () => {
  it('is reported as down instead of holding the response open', async () => {
    const { logger } = recordingLogger();
    const useCase = new CheckReadinessUseCase(
      [neverAnsweringProbe('meilisearch')],
      running,
      fixedClock,
      logger,
      { probeTimeoutMs: 20, cacheTtlMs: 0 },
    );

    const result = await useCase.execute();

    expect(result.ready).toBe(false);
    expect(result.dependencies['meilisearch']).toEqual({ status: 'down', detail: 'timeout' });
  });

  /**
   * The timeout is per dependency, not for the whole check: one stuck service must not hide the
   * state of the others, which is the entire reason the body lists them separately.
   */
  it('still reports the dependencies that did answer', async () => {
    const { logger } = recordingLogger();
    const useCase = new CheckReadinessUseCase(
      [neverAnsweringProbe('meilisearch'), probe('postgres', { status: 'up' })],
      running,
      fixedClock,
      logger,
      { probeTimeoutMs: 20, cacheTtlMs: 0 },
    );

    const result = await useCase.execute();

    expect(result.dependencies['postgres']).toEqual({ status: 'up' });
  });
});

/**
 * An orchestrator polls `/ready` every couple of seconds, and a load balancer does it per instance.
 * Without a cache each poll opens a connection to Postgres, Redis, S3 and Meilisearch — the probe
 * becomes a load generator, and the busier the cluster the more it generates.
 */
/**
 * A driver that rejects with something that is not an `Error` — a string, a plain object. The
 * verdict must be the same `down`, and the log must still carry a cause rather than `undefined`:
 * losing the reason is exactly what makes an unauthenticated `/ready` hard to debug.
 */
describe('a probe that rejects with something odd', () => {
  it('is still down, and the reason still reaches the log', async () => {
    const { logger, warnings } = recordingLogger();
    const useCase = new CheckReadinessUseCase(
      [{ dependency: 'postgres', check: () => Promise.reject('connection lost') }],
      running,
      fixedClock,
      logger,
      { probeTimeoutMs: 1000, cacheTtlMs: 0 },
    );

    const result = await useCase.execute();

    expect(result.dependencies['postgres']).toEqual({ status: 'down' });
    expect(String((warnings[0]?.fields as { err?: unknown }).err)).toContain('connection lost');
  });
});

describe('caching the verdict', () => {
  it('reuses a fresh answer instead of asking every dependency again', async () => {
    const { logger } = recordingLogger();
    const { probe: counted, calls } = countingProbe('postgres', { status: 'up' });
    const { clock, advance } = movableClock(FIXED_NOW);
    const useCase = new CheckReadinessUseCase([counted], running, clock, logger, {
      probeTimeoutMs: 1000,
      cacheTtlMs: 2000,
    });

    await useCase.execute();
    advance(1999);
    const second = await useCase.execute();

    expect(calls()).toBe(1);
    expect(second.ready).toBe(true);
  });

  it('asks again once the answer is stale', async () => {
    const { logger } = recordingLogger();
    const { probe: counted, calls } = countingProbe('postgres', { status: 'up' });
    const { clock, advance } = movableClock(FIXED_NOW);
    const useCase = new CheckReadinessUseCase([counted], running, clock, logger, {
      probeTimeoutMs: 1000,
      cacheTtlMs: 2000,
    });

    await useCase.execute();
    advance(2001);
    await useCase.execute();

    expect(calls()).toBe(2);
  });

  /**
   * Shutdown is read on every call, cache or not. It is the one input that changes without any
   * dependency changing, and a `/ready` that kept answering 200 for two seconds after the process
   * began stopping would send the load balancer exactly the requests this endpoint exists to divert.
   */
  it('never serves a cached «ready» once the process starts stopping', async () => {
    const { logger } = recordingLogger();
    const { probe: counted } = countingProbe('postgres', { status: 'up' });
    const { clock } = movableClock(FIXED_NOW);
    let stoppingNow = false;
    const lifecycle: ProcessLifecyclePort = { isShuttingDown: () => stoppingNow };
    const useCase = new CheckReadinessUseCase([counted], lifecycle, clock, logger, {
      probeTimeoutMs: 1000,
      cacheTtlMs: 2000,
    });

    expect((await useCase.execute()).ready).toBe(true);
    stoppingNow = true;

    const afterShutdownBegan = await useCase.execute();

    expect(afterShutdownBegan.ready).toBe(false);
    expect(afterShutdownBegan.shuttingDown).toBe(true);
  });
});
