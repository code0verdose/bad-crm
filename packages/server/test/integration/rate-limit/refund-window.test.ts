import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { rateLimitKeyOf } from '@/infrastructure/rate-limit/rate-limit-key.util.js';
import { RATE_LIMIT_POLICY } from '@/infrastructure/rate-limit/rate-limit-policy.constant.js';
import { RedisRateLimiterAdapter } from '@/infrastructure/rate-limit/rate-limiter.adapter.js';
import { createRedisWindowLimiters } from '@/infrastructure/rate-limit/redis-window-limiter.factory.js';

import { recordingLogger } from '../../unit/rate-limit/recording-logger.util.js';

/** Same major as `docker-compose.yml`; the decrement under test is Lua running on this server. */
const IMAGE = 'redis:8.8.1-alpine';

const AUTH = RATE_LIMIT_POLICY.auth_attempt;
const SUBJECT = { ipAddress: '203.0.113.42', email: 'ada@example.com' } as const;

let container: StartedRedisContainer;
let url: string;

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

/** The key the library writes, as the library writes it — prefix included. */
const redisKeyFor = async (client: Redis): Promise<string | undefined> => {
  const suffix = rateLimitKeyOf('auth_attempt', SUBJECT).value;
  const keys = await client.keys('*');

  return keys.find((key) => key.endsWith(suffix));
};

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
 * What a refund does to the actual counter in an actual Redis, rather than to a double.
 *
 * The claim being pinned is one the double got wrong for as long as it existed: `reward` is not a
 * guarded decrement. `RateLimiterRedis._upsert` runs `incrby` behind `set key 0 EX ttl NX`, so a
 * reward against a key that is not there **creates** one holding minus one, with a full fresh
 * window — and the next window then opens with six attempts where the policy grants five. Reading
 * the library source says that; only this file measures it.
 */
describe('returning a point to a window that is gone', () => {
  it('leaves no counter behind, so the next window still grants exactly five', async () => {
    const { adapter, client } = await replica();

    await adapter.consume('auth_attempt', SUBJECT);
    // The parallel success: a second request of the same subject signed in and cleared the counter
    // while this one was still parked in the argon2 queue.
    await adapter.reset('auth_attempt', SUBJECT);

    await adapter.refund('auth_attempt', SUBJECT);

    expect(await redisKeyFor(client)).toBeUndefined();

    const decisions = [];

    for (let attempt = 0; attempt < AUTH.points + 1; attempt += 1) {
      decisions.push(await adapter.consume('auth_attempt', SUBJECT));
    }

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(AUTH.points);
    expect(decisions.at(-1)).toMatchObject({ allowed: false });

    client.disconnect();
  });

  /**
   * CONTROL, and the measurement itself: the same store, the same key, the library's decrement
   * called directly. Without it the case above would pass just as well against an adapter whose
   * refund did nothing at all for any reason — including a reason that also breaks the refund on the
   * path it exists for.
   */
  it('is the library, not the adapter, that would have created a counter at minus one', async () => {
    const { client } = await replica();
    const limiters = createRedisWindowLimiters(client);
    const key = rateLimitKeyOf('auth_attempt', SUBJECT).value;

    const reading = await limiters.auth_attempt.attempts.reward(key, 1);

    expect(reading.consumedPoints).toBe(-1);

    const written = await redisKeyFor(client);

    expect(written).toBeDefined();
    // A full fresh window, not the remainder of one that was already running.
    expect(await client.ttl(written ?? '')).toBeGreaterThan(AUTH.windowSeconds - 5);

    client.disconnect();
  });

  it('still returns the point while the window is open', async () => {
    const { adapter, client } = await replica();

    for (let attempt = 0; attempt < AUTH.points; attempt += 1) {
      await adapter.consume('auth_attempt', SUBJECT);
    }

    // CONTROL: the budget really is spent, so the admission below is the refund and not a fresh key.
    await adapter.refund('auth_attempt', SUBJECT);

    await expect(adapter.consume('auth_attempt', SUBJECT)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(adapter.consume('auth_attempt', SUBJECT)).resolves.toMatchObject({
      allowed: false,
    });

    client.disconnect();
  });
});
