import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';

import { buildContainer } from '@/infrastructure/bootstrap/container.factory.js';
import { createRootLogger } from '@/infrastructure/logging/pino-logger.adapter.js';
import { detachedRateLimit } from '@/infrastructure/rate-limit/detached-rate-limit.adapter.js';
import { type RedisConnection } from '@/infrastructure/redis/redis.client.js';

import { testEnv } from '../../support/test-app.util.js';

/**
 * The half of the composition root that owns Redis.
 *
 * `RedisRateLimiterAdapter` was built, covered against a live server, and called from nowhere: no
 * `consume` existed anywhere under `src`, and no ioredis client was ever opened. A limiter nothing
 * constructs is a limiter that is not there, so what these assert is the wiring itself — the client
 * exists, it is closed on the way out, `/ready` asks it whether it is up, and a container built
 * without one refuses rather than admits (STORY-006-07).
 */

const logger = (): ReturnType<typeof createRootLogger> =>
  createRootLogger({ level: 'silent', version: '0.0.0' }, { write: () => undefined });

const opened: Redis[] = [];

/**
 * A real ioredis client that never dials: `lazyConnect` defers the socket until the first command,
 * and no command is issued here. The client has to be real because `RateLimiterRedis` registers a
 * Lua script on it through `defineCommand` while the container is being built.
 */
const idleRedis = (): RedisConnection & { closed: number } => {
  const client = new Redis({ lazyConnect: true });

  opened.push(client);

  const connection = {
    client,
    closed: 0,
    close: (): Promise<void> => {
      connection.closed += 1;
      client.disconnect();

      return Promise.resolve();
    },
  };

  return connection;
};

afterEach(() => {
  for (const client of opened.splice(0)) client.disconnect();
});

describe('a process that has Redis', () => {
  it('closes the connection during shutdown, after the listener has drained', async () => {
    const redis = idleRedis();
    const container = buildContainer({ env: testEnv(), logger: logger(), redis });

    expect(container.shutdownSteps.map((step) => step.name)).toContain('redis');

    await Promise.all(container.shutdownSteps.map((step) => step.close()));
    expect(redis.closed).toBe(1);
  });

  /**
   * A live probe, not a line in a table of optional services. Redis is required: with it down the
   * authentication path refuses every request by design, so an instance that cannot reach it must
   * be taken out of rotation rather than left answering 503 to users.
   */
  it('reports Redis on /ready and calls it down while the client is not connected', async () => {
    const container = buildContainer({ env: testEnv(), logger: logger(), redis: idleRedis() });

    const readiness = await container.http.checkReadiness.execute();

    expect(readiness.dependencies['redis']).toEqual({ status: 'down', detail: 'wait' });
    expect(readiness.ready).toBe(false);
  });
});

describe('a container built without Redis', () => {
  it('registers no shutdown step and no probe for it', async () => {
    const container = buildContainer({ env: testEnv(), logger: logger() });

    expect(container.shutdownSteps.map((step) => step.name)).not.toContain('redis');
    expect((await container.http.checkReadiness.execute()).dependencies['redis']).toBeUndefined();
  });

  /**
   * And its limiter refuses. This is the same fail-closed direction the adapter takes when the
   * store is unreachable: a stand-in that answered `allowed: true` would make a misconfigured
   * process the one with no brute-force defence, which is the deployment least likely to notice.
   */
  it('answers every attempt with service_unavailable rather than admitting it', async () => {
    await expect(
      detachedRateLimit().consume('auth_attempt', {
        ipAddress: '203.0.113.42',
        email: 'ada@example.com',
      }),
    ).rejects.toMatchObject({ code: 'service_unavailable', status: 503 });
  });

  /**
   * `reset` stays silent, for the same reason the real adapter swallows a failed clear: it runs
   * after a credential was already accepted, and turning a correct sign-in into a 503 would be a
   * worse answer than a counter nobody cleared.
   */
  it('lets a reset pass silently, because by then somebody has already signed in', async () => {
    await expect(
      detachedRateLimit().reset('auth_attempt', {
        ipAddress: '203.0.113.42',
        email: 'ada@example.com',
      }),
    ).resolves.toBeUndefined();
  });
});
