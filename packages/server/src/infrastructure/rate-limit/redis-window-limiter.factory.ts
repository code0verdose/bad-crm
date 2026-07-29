import { type Redis } from 'ioredis';
import { RateLimiterRedis } from 'rate-limiter-flexible';

import { RATE_LIMIT_POLICIES } from '@/application/platform/ports/rate-limit.port.js';
import { RATE_LIMIT_POLICY } from '@/infrastructure/rate-limit/rate-limit-policy.constant.js';
import {
  type PolicyLimiters,
  type WindowLimiters,
} from '@/infrastructure/rate-limit/window-limiter.types.js';

/** Namespace of every counter this subsystem owns, so `FLUSHDB` is never the only way to find them. */
const KEY_PREFIX = 'rl';

/**
 * A counter that only records. Its budget is never reached, so it never refuses anything — what is
 * read from it is `consumedPoints`, the number of lock-outs remembered for a subject.
 */
const PENALTY_POINTS = Number.MAX_SAFE_INTEGER;

/**
 * The Redis-backed limiters, one pair per policy.
 *
 * The client is passed in rather than created here: one connection serves the limiter, BullMQ and
 * the Socket.IO adapter, it is opened by the composition root and closed by the shutdown handler
 * (`rules/hexagonal-backend.mdc`, rules 12 and 13). A module that opens its own would be a second
 * connection nobody closes and a second place that knows `REDIS_URL`.
 *
 * Two options carry the whole failure policy of this subsystem:
 *
 * - **`insuranceLimiter` is not set.** It is the library's fallback to `RateLimiterMemory` when the
 *   store is unreachable — that is, to a counter that is per-process and lost on restart. With two
 *   replicas it hands out twice the budget, and with a crash loop it hands out an unlimited one:
 *   the fail-open behaviour STORY-006-07 exists to forbid. Its absence is what makes `consume`
 *   reject with the driver's error, which the adapter turns into a 503.
 * - **`rejectIfRedisNotReady: true`.** ioredis queues commands while it is disconnected, so without
 *   this a login during a Redis outage waits for a reconnection instead of being refused — an
 *   outage that presents as a hanging login rather than a stated one, and a request pile-up on top.
 */
export const createRedisWindowLimiters = (client: Redis): WindowLimiters =>
  Object.fromEntries(
    RATE_LIMIT_POLICIES.map((policy) => {
      const definition = RATE_LIMIT_POLICY[policy];

      const limiters: PolicyLimiters = {
        attempts: new RateLimiterRedis({
          storeClient: client,
          keyPrefix: `${KEY_PREFIX}:${policy}`,
          points: definition.points,
          duration: definition.windowSeconds,
          blockDuration: definition.blockSeconds,
          rejectIfRedisNotReady: true,
        }),
        penalties: new RateLimiterRedis({
          storeClient: client,
          keyPrefix: `${KEY_PREFIX}:${policy}:penalty`,
          points: PENALTY_POINTS,
          duration: definition.escalation?.memorySeconds ?? definition.blockSeconds,
          rejectIfRedisNotReady: true,
        }),
      };

      return [policy, limiters];
    }),
  ) as WindowLimiters;
