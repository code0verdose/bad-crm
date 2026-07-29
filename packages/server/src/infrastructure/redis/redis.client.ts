import { Redis } from 'ioredis';

import { type LoggerPort } from '@/application/platform/ports/logger.port.js';

/** How long a single command may wait for a reply before it is treated as a failure. */
const COMMAND_TIMEOUT_MS = 2_000;

/**
 * Redis as the rest of the process sees it: one connection and a way to close it.
 *
 * One, deliberately. The rate limiter, and later BullMQ and the Socket.IO adapter, share it — a
 * module that opened its own would be a second connection nobody closes and a second place that
 * knows `REDIS_URL` (`rules/hexagonal-backend.mdc`, rules 12 and 13).
 */
export interface RedisConnection {
  readonly client: Redis;
  close(): Promise<void>;
}

export interface ConnectRedisOptions {
  readonly url: string;
  readonly logger: LoggerPort;
}

/**
 * Opens the connection. It does **not** wait for it: `startApiProcess` must not hang on a Redis
 * that is still booting, and the alternative to waiting is not "start without a limiter" — a
 * command issued before the connection is ready is *refused* rather than queued, so a sign-in
 * during a Redis outage is answered 503 and never admitted (`redis-window-limiter.factory.ts`,
 * `rejectIfRedisNotReady`). `/ready` reports the state until it settles, which keeps the instance
 * out of the load balancer's rotation rather than out of the deployment.
 *
 * Three options carry that behaviour:
 *
 * - **`enableOfflineQueue: false`.** ioredis otherwise buffers commands while disconnected and
 *   replays them on reconnect, so an outage presents as requests that hang for as long as it lasts
 *   instead of as requests that are refused. A limiter that hangs is worse than one that says no.
 * - **`maxRetriesPerRequest: 1`.** The default of twenty turns one unlucky command into seconds of
 *   silent retrying inside a request nobody is timing out.
 * - **`commandTimeout`.** The upper bound on all of it, so a half-open socket cannot hold a
 *   handler open until the client notices.
 *
 * The error handler is what keeps a connection failure from becoming an `unhandledRejection`:
 * ioredis emits `error` on a socket that cannot be reached, and an `error` event with no listener
 * is a thrown exception on the process object.
 */
export const connectRedis = ({ url, logger }: ConnectRedisOptions): RedisConnection => {
  const client = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: COMMAND_TIMEOUT_MS,
  });

  client.on('error', (error: unknown) => {
    // `err` and nothing else: the URL carries the password, and the driver's message quotes the
    // URL. The serializer strips what it can; naming the host here would defeat it.
    logger.warn({ err: error }, 'redis connection error');
  });

  return {
    client,
    // `quit` rather than `disconnect`: it lets replies already in flight arrive, which is the whole
    // difference between a graceful stop and a torn one. A client that never connected rejects it,
    // and the shutdown handler logs that step and carries on with the rest.
    close: async (): Promise<void> => {
      await client.quit();
    },
  };
};
