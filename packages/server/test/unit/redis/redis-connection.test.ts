import { type Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';

import { redisReadinessProbe } from '@/infrastructure/redis/redis-readiness.adapter.js';
import { connectRedis } from '@/infrastructure/redis/redis.client.js';

import { RecordingLogger } from '../../support/identity-doubles.util.js';

/**
 * The connection and its probe, without a server.
 *
 * What is worth asserting here is not that ioredis can talk to Redis — it can — but the two things
 * this module adds on top of it: an `error` listener, whose absence turns a connection failure into
 * an `unhandledRejection` that takes the process down, and a probe whose answer decides whether the
 * instance stays in the load balancer's rotation.
 */

/** The slice of the client the probe reads, which is a status and a `PING`. */
const clientWith = (status: string, ping: () => Promise<string>): Redis =>
  ({ status, ping }) as unknown as Redis;

describe('the readiness probe', () => {
  it('reports the dependency under the name the /ready body uses', () => {
    expect(redisReadinessProbe(clientWith('ready', () => Promise.resolve('PONG'))).dependency).toBe(
      'redis',
    );
  });

  it('answers up when the server replies', async () => {
    const probe = redisReadinessProbe(clientWith('ready', () => Promise.resolve('PONG')));

    await expect(probe.check()).resolves.toEqual({ status: 'up' });
  });

  /**
   * A connection that is not up is `down` **without** a command being sent. The status is carried
   * as `detail` because "reconnecting" and "the server answered nothing" are different mornings for
   * whoever reads the probe — and because it is a word from a closed set, unlike a driver message,
   * which quotes the connection URL and therefore the password.
   */
  it.each(['connecting', 'reconnecting', 'end', 'wait'])(
    'answers down with the state while the client is %s, sending no command',
    async (status) => {
      const pinged: string[] = [];
      const probe = redisReadinessProbe(
        clientWith(status, () => {
          pinged.push('ping');

          return Promise.resolve('PONG');
        }),
      );

      await expect(probe.check()).resolves.toEqual({ status: 'down', detail: status });
      expect(pinged).toEqual([]);
    },
  );

  /**
   * A `PING` that fails propagates. `CheckReadinessUseCase` catches it, logs it and reports `down`,
   * which is the one place a driver exception is allowed to be seen — it never reaches the body.
   */
  it('lets a failing command out, for the use-case to turn into down', async () => {
    const probe = redisReadinessProbe(
      clientWith('ready', () => Promise.reject(new Error('connection reset'))),
    );

    await expect(probe.check()).rejects.toThrow('connection reset');
  });
});

describe('opening the connection', () => {
  const clients: { disconnect: () => void }[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect();
  });

  /**
   * An `error` event with no listener is a thrown exception on the process object, and a Redis that
   * is briefly unreachable emits one every retry — so the missing listener is not a lint nit, it is
   * the process exiting during an outage it was designed to survive by refusing requests.
   */
  it('logs a connection error instead of letting it kill the process', () => {
    const logger = new RecordingLogger();
    const { client } = connectRedis({
      // Port 1 on loopback: nothing listens, so nothing outside this machine is contacted.
      url: 'redis://user:hunter2@127.0.0.1:1', // scan-secrets:allow gitleaks:allow
      logger,
    });

    clients.push(client);
    client.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:1'));

    const line = logger.lines.find((entry) => entry.message === 'redis connection error');

    expect(line?.level).toBe('warn');
    expect(line?.fields['err']).toBeInstanceOf(Error);
  });

  it('never writes the connection string, which carries the password', () => {
    const logger = new RecordingLogger();
    const { client } = connectRedis({
      url: 'redis://user:hunter2@127.0.0.1:1', // scan-secrets:allow gitleaks:allow
      logger,
    });

    clients.push(client);
    client.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:1'));

    expect(JSON.stringify(logger.lines)).not.toContain('hunter2');
  });

  /**
   * The options that make the limiter's fail-closed policy reachable at all: a queued command is a
   * sign-in that hangs for the length of the outage instead of one that is refused, and twenty
   * silent retries is the same thing spread over seconds.
   */
  it('refuses commands while disconnected rather than queueing them', () => {
    const logger = new RecordingLogger();
    const { client } = connectRedis({ url: 'redis://127.0.0.1:1', logger });

    clients.push(client);

    expect(client.options.enableOfflineQueue).toBe(false);
    expect(client.options.maxRetriesPerRequest).toBe(1);
    expect(client.options.commandTimeout).toBeGreaterThan(0);
  });
});
