import { type Redis } from 'ioredis';

import {
  type DependencyReport,
  type ReadinessProbePort,
} from '@/application/platform/ports/readiness-probe.port.js';

/** The key this dependency appears under in the `/ready` body. */
const DEPENDENCY = 'redis';

/**
 * A live probe for Redis, unlike the `disabled` entries beside it.
 *
 * Redis is not optional on this installation: with it unreachable the limiter refuses every
 * authentication attempt by design (fail closed, STORY-006-07), so an instance that cannot reach it
 * serves 503s to users. Reporting it `down` takes that instance out of the load balancer's rotation
 * instead, which is the difference between a rolling restart and an outage.
 *
 * The connection state is read before a command is sent. `PING` on a client that is still dialling
 * would be refused anyway — the connection is built with `enableOfflineQueue: false` — but the
 * status says *which* state it is in, and "reconnecting" and "the server answered nothing" are
 * different mornings for whoever is reading the probe.
 *
 * `detail` carries that state and nothing else. `/ready` is unauthenticated, and a driver's
 * exception message quotes the connection URL, which quotes the password.
 */
export const redisReadinessProbe = (client: Redis): ReadinessProbePort => ({
  dependency: DEPENDENCY,
  check: async (): Promise<DependencyReport> => {
    if (client.status !== 'ready') return { status: 'down', detail: client.status };

    await client.ping();

    return { status: 'up' };
  },
});
