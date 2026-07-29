import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';

import { RATE_LIMIT_POLICY } from '@/infrastructure/rate-limit/rate-limit-policy.constant.js';
import { createRedisWindowLimiters } from '@/infrastructure/rate-limit/redis-window-limiter.factory.js';

/**
 * `lazyConnect` — the client is constructed and never dials: building the limiters is pure
 * configuration, and this suite is about that configuration, not about Redis. The behaviour against
 * a live server is asserted in `test/integration/rate-limit/**`.
 */
const client = new Redis({ lazyConnect: true, port: 0 });

afterAll(() => {
  client.disconnect();
});

describe('redis window limiters', () => {
  const limiters = createRedisWindowLimiters(client);

  it('configures every policy with its own budget and window', () => {
    for (const [name, policy] of Object.entries(RATE_LIMIT_POLICY)) {
      const attempts = limiters[name as keyof typeof limiters].attempts as unknown as {
        points: number;
        duration: number;
      };

      expect(attempts.points, name).toBe(policy.points);
      expect(attempts.duration, name).toBe(policy.windowSeconds);
    }
  });

  it('gives every policy a key prefix of its own, so two limits never share a counter', () => {
    const prefixes = Object.values(limiters).map(
      (policy) => (policy.attempts as unknown as { keyPrefix: string }).keyPrefix,
    );

    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('keeps the escalation memory in a separate namespace from the attempts', () => {
    const attempts = (limiters.auth_attempt.attempts as unknown as { keyPrefix: string }).keyPrefix;
    const penalties = (limiters.auth_attempt.penalties as unknown as { keyPrefix: string })
      .keyPrefix;

    expect(penalties).not.toBe(attempts);
  });

  /**
   * `insuranceLimiter` is the library's fail-open switch: set it, and a Redis outage silently moves
   * the counter into the memory of one process — which is both unshared and reset by a restart.
   * That is the exact behaviour STORY-006-07 forbids, and it is one option away.
   */
  it('sets no insurance limiter, because falling back to process memory is failing open', () => {
    for (const policy of Object.values(limiters)) {
      expect(
        (policy.attempts as unknown as { insuranceLimiter: unknown }).insuranceLimiter,
      ).toBeUndefined();
    }
  });
});
