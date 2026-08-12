import { type Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';
import { RedisTokenDenylistAdapter } from '@/infrastructure/redis/redis-token-denylist.adapter.js';

import { RecordingLogger } from '../../support/identity-doubles.util.js';

/**
 * A minimal `Redis` for the two commands this adapter issues — the same technique
 * `redis-connection.test.ts` uses for the readiness probe: a plain object cast to the client type,
 * not a real connection.
 */
const clientWith = (
  set: (...args: unknown[]) => Promise<'OK'>,
  exists: (...args: unknown[]) => Promise<number>,
): Redis => ({ set, exists }) as unknown as Redis;

describe('the token denylist — marking a key spent', () => {
  it('writes the key under the denylist namespace with the given TTL', async () => {
    const calls: unknown[][] = [];
    const client = clientWith(
      (...args) => {
        calls.push(args);

        return Promise.resolve('OK');
      },
      () => Promise.resolve(0),
    );
    const adapter = new RedisTokenDenylistAdapter(client, new RecordingLogger());

    await adapter.revoke('mfa-pending-token:abc123', 300);

    expect(calls).toEqual([['denylist:mfa-pending-token:abc123', '1', 'EX', 300]]);
  });
});

describe('the token denylist — checking a key', () => {
  it('reports revoked when the store holds the key', async () => {
    const client = clientWith(
      () => Promise.resolve('OK'),
      () => Promise.resolve(1),
    );
    const adapter = new RedisTokenDenylistAdapter(client, new RecordingLogger());

    await expect(adapter.isRevoked('mfa-pending-token:abc123')).resolves.toBe(true);
  });

  it('reports not revoked when the store lacks the key', async () => {
    const client = clientWith(
      () => Promise.resolve('OK'),
      () => Promise.resolve(0),
    );
    const adapter = new RedisTokenDenylistAdapter(client, new RecordingLogger());

    await expect(adapter.isRevoked('mfa-pending-token:abc123')).resolves.toBe(false);
  });

  it('reads under the same namespace it writes under', async () => {
    const seen: unknown[][] = [];
    const client = clientWith(
      () => Promise.resolve('OK'),
      (...args) => {
        seen.push(args);

        return Promise.resolve(0);
      },
    );
    const adapter = new RedisTokenDenylistAdapter(client, new RecordingLogger());

    await adapter.isRevoked('mfa-pending-token:abc123');

    expect(seen).toEqual([['denylist:mfa-pending-token:abc123']]);
  });
});

/**
 * The property this whole suite exists for, the same one `rate-limiter.adapter.test.ts` asserts for
 * the brute-force limiter: a store that cannot be reached must never be answered as "the thing you
 * asked about is not the case".
 */
describe('the token denylist — an unreachable store', () => {
  it('rejects `isRevoked` instead of resolving false', async () => {
    const failure = new Error('READONLY You cannot write against a replica');
    const client = clientWith(
      () => Promise.resolve('OK'),
      () => Promise.reject(failure),
    );
    const adapter = new RedisTokenDenylistAdapter(client, new RecordingLogger());

    await expect(adapter.isRevoked('mfa-pending-token:abc123')).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });

  it('answers 503 on `isRevoked`, so the caller learns the difference from "not spent"', async () => {
    const client = clientWith(
      () => Promise.resolve('OK'),
      () => Promise.reject(new Error('connection lost')),
    );
    const adapter = new RedisTokenDenylistAdapter(client, new RecordingLogger());

    await expect(adapter.isRevoked('mfa-pending-token:abc123')).rejects.toMatchObject({
      code: 'service_unavailable',
      status: 503,
    });
  });

  it('rejects `revoke` instead of silently doing nothing', async () => {
    const failure = new Error('connection lost');
    const client = clientWith(
      () => Promise.reject(failure),
      () => Promise.resolve(0),
    );
    const adapter = new RedisTokenDenylistAdapter(client, new RecordingLogger());

    await expect(adapter.revoke('mfa-pending-token:abc123', 300)).rejects.toMatchObject({
      code: 'service_unavailable',
      status: 503,
    });
  });

  it('keeps the driver failure as the cause and out of the response', async () => {
    const failure = new Error('READONLY You cannot write against a replica');
    const client = clientWith(
      () => Promise.resolve('OK'),
      () => Promise.reject(failure),
    );
    const adapter = new RedisTokenDenylistAdapter(client, new RecordingLogger());

    const error = await adapter
      .isRevoked('mfa-pending-token:abc123')
      .then(() => undefined)
      .catch((raised: unknown) => raised);

    expect((error as ServiceUnavailableError).cause).toBe(failure);
    expect((error as ServiceUnavailableError).message).not.toContain('READONLY');
  });

  it('logs at error level, without the raw driver message', async () => {
    const client = clientWith(
      () => Promise.resolve('OK'),
      () => Promise.reject(new Error('READONLY You cannot write against a replica')),
    );
    const logger = new RecordingLogger();
    const adapter = new RedisTokenDenylistAdapter(client, logger);

    await adapter.isRevoked('mfa-pending-token:abc123').catch(() => undefined);

    expect(logger.lines.some((line) => line.level === 'error')).toBe(true);
    expect(logger.lines.map((line) => line.message).join('\n')).not.toContain('READONLY');
  });
});
