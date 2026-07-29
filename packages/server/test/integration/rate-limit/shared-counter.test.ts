import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';
import { RATE_LIMIT_POLICY } from '@/infrastructure/rate-limit/rate-limit-policy.constant.js';
import { RedisRateLimiterAdapter } from '@/infrastructure/rate-limit/rate-limiter.adapter.js';
import { createRedisWindowLimiters } from '@/infrastructure/rate-limit/redis-window-limiter.factory.js';

import { recordingLogger } from '../../unit/rate-limit/recording-logger.util.js';

/** Same major as `docker-compose.yml`; a limiter is Lua on the server, and the server is the test. */
const IMAGE = 'redis:8.8.1-alpine';

const AUTH = RATE_LIMIT_POLICY.auth_attempt;

let container: StartedRedisContainer;
let url: string;

/**
 * Two clients, two adapters — one per "replica" of the application.
 *
 * The `ping` is not ceremony: the limiters are built with `rejectIfRedisNotReady`, so a command
 * issued while ioredis is still dialling is *refused*, not queued. That is the fail-closed
 * behaviour this suite also asserts further down, and in a real process the readiness probe holds
 * traffic back until the connection is up. Here nothing does, so the connection is awaited.
 */
const replica = async (): Promise<{ adapter: RedisRateLimiterAdapter; client: Redis }> => {
  const client = new Redis(url);
  await client.ping();

  return {
    client,
    adapter: new RedisRateLimiterAdapter(
      createRedisWindowLimiters(client),
      recordingLogger().logger,
    ),
  };
};

const subject = (email: string) => ({ ipAddress: '203.0.113.42', email }) as const;

beforeAll(async () => {
  container = await new RedisContainer(IMAGE).start();
  url = container.getConnectionUrl();
}, 300_000);

afterAll(async () => {
  await container?.stop();
});

beforeEach(async () => {
  const client = new Redis(url);
  await client.flushall();
  client.disconnect();
});

/**
 * The claim of STORY-006-07 that no in-memory limiter can satisfy: **the budget is one budget, not
 * one per process.** Two replicas behind a load balancer must not hand out ten attempts where the
 * policy grants five — and they do exactly that the moment the counter lives in `RateLimiterMemory`.
 */
describe('the counter is shared by every replica', () => {
  it('spends one budget of five across two processes, not five each', async () => {
    const first = await replica();
    const second = await replica();
    const pair = subject('shared@example.com');
    const decisions = [];

    // Alternating, the way a round-robin balancer would distribute them.
    for (let attempt = 0; attempt < AUTH.points + 1; attempt += 1) {
      const target = attempt % 2 === 0 ? first : second;
      decisions.push(await target.adapter.consume('auth_attempt', pair));
    }

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(AUTH.points);
    expect(decisions.at(-1)).toMatchObject({ allowed: false });

    first.client.disconnect();
    second.client.disconnect();
  });

  it('lets a replica that never saw a failure refuse the attempt after it', async () => {
    const noisy = await replica();
    const fresh = await replica();
    const pair = subject('cross-replica@example.com');

    for (let attempt = 0; attempt < AUTH.points; attempt += 1) {
      await noisy.adapter.consume('auth_attempt', pair);
    }

    expect(await fresh.adapter.consume('auth_attempt', pair)).toMatchObject({ allowed: false });

    noisy.client.disconnect();
    fresh.client.disconnect();
  });

  it('answers a Retry-After that is the real remaining block, not a constant', async () => {
    const only = await replica();
    const pair = subject('retry-after@example.com');

    for (let attempt = 0; attempt < AUTH.points; attempt += 1) {
      await only.adapter.consume('auth_attempt', pair);
    }

    const decision = await only.adapter.consume('auth_attempt', pair);

    if (decision.allowed) throw new Error('unreachable');
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(AUTH.blockSeconds);

    // Positive control on the assertion above: the counter really is in the store, not in the object.
    const ttl = await only.client.pttl(
      (await only.client.keys('*')).find((key) => key.includes('auth')) ?? '',
    );
    expect(ttl).toBeGreaterThan(0);

    only.client.disconnect();
  });

  it('clears the shared budget when a sign-in succeeds on any replica', async () => {
    const failing = await replica();
    const succeeding = await replica();
    const pair = subject('reset@example.com');

    for (let attempt = 0; attempt < AUTH.points; attempt += 1) {
      await failing.adapter.consume('auth_attempt', pair);
    }
    await succeeding.adapter.reset('auth_attempt', pair);

    expect(await failing.adapter.consume('auth_attempt', pair)).toMatchObject({ allowed: true });

    failing.client.disconnect();
    succeeding.client.disconnect();
  });

  it('keeps two pairs from the same address apart', async () => {
    const only = await replica();

    for (let attempt = 0; attempt < AUTH.points + 1; attempt += 1) {
      await only.adapter.consume('auth_attempt', subject('victim@example.com'));
    }

    expect(
      await only.adapter.consume('auth_attempt', subject('colleague@example.com')),
    ).toMatchObject({ allowed: true });

    only.client.disconnect();
  });
});

/**
 * Fail-closed against the real thing. The unit suite proves the adapter maps a rejected store call
 * to a 503; this proves that an unreachable Redis *produces* such a call rather than hanging on
 * ioredis's offline queue until the request times out — which would be an outage that looks like a
 * slow login instead of a refused one.
 */
describe('an unreachable Redis', () => {
  it('refuses authentication instead of letting every attempt through', async () => {
    const stopped = await new RedisContainer(IMAGE).start();
    const client = new Redis(stopped.getConnectionUrl(), { maxRetriesPerRequest: 1 });
    await client.ping();
    const adapter = new RedisRateLimiterAdapter(
      createRedisWindowLimiters(client),
      recordingLogger().logger,
    );

    expect(await adapter.consume('auth_attempt', subject('before@example.com'))).toMatchObject({
      allowed: true,
    });

    await stopped.stop();

    await expect(
      adapter.consume('auth_attempt', subject('after@example.com')),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);

    client.disconnect();
  }, 300_000);
});
