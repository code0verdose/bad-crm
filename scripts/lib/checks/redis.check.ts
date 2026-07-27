import type { CheckOutcome, ServiceCheck } from '../service-check.types.js';
import type { RedisTarget } from '../connection-target.util.js';
import { DEV_STACK_REMEDY, withTransportFailure } from './transport.util.js';

/**
 * Redis over its inline command protocol.
 *
 * `PING\r\n` on a raw socket is a complete, documented Redis request — which is why this check
 * needs no client library. A dependency would be a second, differently configured Redis
 * connection in a repository that already has to keep one honest.
 */

export const redisCommandsFor = (password: string | undefined): string[] =>
  password === undefined ? ['PING'] : [`AUTH ${password}`, 'PING'];

export const interpretRedisReply = (reply: string): CheckOutcome => {
  const lines = reply.split('\r\n').filter((line) => line !== '');
  const error = lines.find((line) => line.startsWith('-'));

  if (error !== undefined) {
    return {
      status: 'failed',
      details: [`Redis refused the command: ${error.slice(1)}`],
      remedy:
        'check REDIS_URL — the password in the URL has to match the one the redis container runs with',
    };
  }

  if (!lines.includes('+PONG')) {
    return {
      status: 'failed',
      details: [
        lines.length === 0
          ? 'Redis accepted the connection but sent no reply to PING'
          : `unexpected reply to PING: ${lines.join(' ')}`,
      ],
      remedy: 'inspect the container with `docker compose logs redis`',
    };
  }

  return { status: 'ok', details: ['PING answered PONG'] };
};

export const createRedisCheck = (options: {
  readonly redisUrl: string;
  readonly target: RedisTarget;
  readonly send: (target: RedisTarget, commands: readonly string[]) => Promise<string>;
}): ServiceCheck => ({
  service: 'redis',
  requirement: 'required',
  target: `${options.target.host}:${options.target.port}`,
  run: async () =>
    withTransportFailure(DEV_STACK_REMEDY, async () =>
      interpretRedisReply(
        await options.send(options.target, redisCommandsFor(options.target.password)),
      ),
    ),
});
