import {
  type RateLimitDecision,
  type RateLimitPort,
} from '@/application/platform/ports/rate-limit.port.js';
import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';

/**
 * The limiter of a container that was built without a Redis connection.
 *
 * The same shape, and the same reasoning, as `detached-database.adapter.ts`: the HTTP and contract
 * suites build the real application out of in-process adapters and drive it through supertest, so
 * the container has to be constructible without opening a socket — and the routes have to exist
 * either way, or the contract test would compare the specification against a router missing half
 * the authentication surface.
 *
 * **It refuses, and that is the point.** A stand-in that answered `allowed: true` would mean the
 * one deployment with no brute-force defence at all is the misconfigured one — the deployment least
 * likely to notice, and the one an attacker can produce by making Redis unreachable
 * (`docs/security/threat-model.md`, T-IAM-03). The refusal is the same `503 service_unavailable`
 * the real adapter raises when the store is down, which `docs/api/openapi.yaml` already declares on
 * `login` and `refresh`.
 *
 * `REDIS_URL` is required by the env schema, so a real process never gets one of these.
 */
export const detachedRateLimit = (): RateLimitPort => ({
  consume: (policy): Promise<RateLimitDecision> =>
    Promise.reject(
      new ServiceUnavailableError({
        dependency: 'redis',
        policy,
        reason: 'this process was started without a Redis connection',
      }),
    ),

  /**
   * Silent, like the real adapter's swallowed failure: `reset` runs after a credential has already
   * been accepted, and turning a correct sign-in into a 503 would be the worse of the two answers.
   */
  reset: (): Promise<void> => Promise.resolve(),
});
