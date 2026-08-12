import { type Redis } from 'ioredis';

import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type TokenDenylistPort } from '@/application/identity/ports/token-denylist.port.js';
import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';

/** Namespace of every key this store owns, so `KEYS mfa-pending-token:*` is not the only way to find them. */
const KEY_PREFIX = 'denylist';

const redisKeyOf = (key: string): string => `${KEY_PREFIX}:${key}`;

/**
 * `TokenDenylistPort` on the same Redis connection the rate limiter, BullMQ and the Socket.IO
 * adapter share (`rules/hexagonal-backend.mdc`, rules 12–13) — the client is passed in rather than
 * opened here.
 *
 * **Fail-closed, and for the identical reason `RedisRateLimiterAdapter` is.** A `SET … EX` or
 * `EXISTS` that cannot reach the store is not "not revoked": it is "the question could not be asked",
 * and answering it as `false` would make an unreachable Redis the cheapest way to make a spent
 * mfa-pending token verify again. Both methods let the driver's rejection become a thrown
 * `ServiceUnavailableError` instead of a resolved value — nothing in this class ever resolves `false`
 * from a `catch` block.
 *
 * The driver's exception is kept as `cause` on the thrown error and out of the `logger.error` call:
 * a connection error from `ioredis` quotes the connection string, the connection string quotes the
 * password, and the log line only needs to say that the store was unreachable, not repeat what the
 * exception already said (the same split `rate-limiter.adapter.ts` and `redis-readiness.adapter.ts`
 * make).
 */
export class RedisTokenDenylistAdapter implements TokenDenylistPort {
  constructor(
    private readonly client: Redis,
    private readonly logger: LoggerPort,
  ) {}

  async revoke(key: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(redisKeyOf(key), '1', 'EX', ttlSeconds);
    } catch (cause) {
      // `error`, not `warn`: nothing can be marked spent until this is fixed, which for an
      // mfa-pending token means the token this call was meant to invalidate keeps verifying until it
      // expires on its own — a security property silently degraded, which is the level's definition
      // (rules/observability.mdc, rule 7).
      this.logger.error({ key }, 'token denylist store unavailable, could not revoke the token');

      throw new ServiceUnavailableError({ dependency: 'redis' }, cause);
    }
  }

  async isRevoked(key: string): Promise<boolean> {
    try {
      const exists = await this.client.exists(redisKeyOf(key));

      return exists === 1;
    } catch (cause) {
      this.logger.error({ key }, 'token denylist store unavailable, refusing to verify the token');

      throw new ServiceUnavailableError({ dependency: 'redis' }, cause);
    }
  }
}
