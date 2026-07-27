import { describe, expect, it } from 'vitest';

import { ServiceUnavailableError } from '../../../src/domain/shared/errors/app.errors.js';
import { CheckHealthUseCase } from '../../../src/application/platform/use-cases/check-health.use-case.js';
import type { ClockPort } from '../../../src/application/platform/ports/clock.port.js';
import type { HealthProbePort } from '../../../src/application/platform/ports/health-probe.port.js';

const FIXED_NOW = new Date('2026-07-27T10:00:00.000Z');

const fixedClock: ClockPort = { now: () => FIXED_NOW };

/** In-memory port, not a mock: the assertions are about the result, never about a call count. */
const probeReturning = (uptimeSeconds: number, version: string): HealthProbePort => ({
  snapshot: () => ({ uptimeSeconds, version }),
});

const failingProbe = (cause: Error): HealthProbePort => ({
  snapshot: () => {
    throw cause;
  },
});

describe('CheckHealthUseCase', () => {
  it('reports the process as alive with its version and uptime', async () => {
    const useCase = new CheckHealthUseCase(probeReturning(42, '1.4.0'), fixedClock);

    await expect(useCase.execute()).resolves.toEqual({
      status: 'alive',
      version: '1.4.0',
      uptimeSeconds: 42,
      checkedAt: FIXED_NOW,
    });
  });

  it('takes its time from the clock port, never from Date.now()', async () => {
    const useCase = new CheckHealthUseCase(probeReturning(1, '0.0.0'), {
      now: () => new Date('2001-01-01T00:00:00.000Z'),
    });

    await expect(useCase.execute()).resolves.toMatchObject({
      checkedAt: new Date('2001-01-01T00:00:00.000Z'),
    });
  });

  /**
   * Liveness answers "is this process still running", so it must not depend on anything that can
   * be slow. With the ports in memory the whole scenario is arithmetic; a future implementation
   * that reaches for the database to answer `/health` fails here rather than during an outage,
   * when a slow database would start restarting healthy containers.
   */
  it('runs without a database, an HTTP server or a container, in under 50 ms', async () => {
    const useCase = new CheckHealthUseCase(probeReturning(7, '0.0.0'), fixedClock);
    const startedAt = performance.now();

    await useCase.execute();

    expect(performance.now() - startedAt).toBeLessThan(50);
  });

  it('translates a failing adapter into a domain error, so infrastructure types do not leak', async () => {
    const cause = new Error('ECONNREFUSED 127.0.0.1:6379');
    const useCase = new CheckHealthUseCase(failingProbe(cause), fixedClock);

    const error = await useCase.execute().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect((error as ServiceUnavailableError).code).toBe('service_unavailable');
    expect((error as ServiceUnavailableError).cause).toBe(cause);
  });
});
