import { type TokenDenylistPort } from '@/application/identity/ports/token-denylist.port.js';
import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';

/**
 * The denylist of a container that was built without a Redis connection.
 *
 * The same shape and the same reasoning as `detached-rate-limit.adapter.ts`: the HTTP and contract
 * suites build the real application out of in-process adapters and drive it through supertest, so
 * the container has to be constructible without opening a socket, and the routes have to exist
 * either way or the contract test would compare the specification against a router missing part of
 * the second-factor sign-in surface.
 *
 * **It refuses both methods, and that is the point.** A stand-in whose `isRevoked` answered `false`
 * would mean the one deployment with no Redis at all is the deployment where a spent mfa-pending
 * token verifies again forever — the deployment least likely to notice, and the one an attacker can
 * produce by making Redis unreachable. The refusal is the same `503 service_unavailable`
 * `RedisTokenDenylistAdapter` raises when the real store is down.
 *
 * `REDIS_URL` is required by the env schema, so a real process never gets one of these.
 */
export const detachedTokenDenylist = (): TokenDenylistPort => ({
  revoke: (): Promise<void> =>
    Promise.reject(
      new ServiceUnavailableError({
        dependency: 'redis',
        reason: 'this process was started without a Redis connection',
      }),
    ),

  isRevoked: (): Promise<boolean> =>
    Promise.reject(
      new ServiceUnavailableError({
        dependency: 'redis',
        reason: 'this process was started without a Redis connection',
      }),
    ),
});
