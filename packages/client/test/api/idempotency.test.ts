import createClient from 'openapi-fetch';
import { describe, expect, it } from 'vitest';

import {
  createApiClient,
  createAuthMiddleware,
  createIdempotencyMiddleware,
  IDEMPOTENCY_KEY_HEADER,
} from '@shared/api';

import { API_BASE_URL } from './test-api.util.js';

/**
 * `Idempotency-Key` is mandatory on every unsafe operation that creates an entity, sends mail or
 * spends money (`rules/api-contract.mdc` §10). The wrapper attaches it so that no call site can
 * forget: a retry after a dropped connection would otherwise create a second task and charge a
 * second time for the same AI completion.
 */
interface WritePaths {
  '/things': {
    post: {
      requestBody: { content: { 'application/json': { title: string } } };
      responses: { 200: { content: { 'application/json': { id: string } } } };
    };
    delete: { responses: { 200: { content: { 'application/json': { id: string } } } } };
  };
}

const ok = (): Response =>
  new Response(JSON.stringify({ id: 'thing-1' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const writeHarness = (newKey?: () => string) => {
  const attempts: Request[] = [];
  const client = createClient<WritePaths>({
    baseUrl: API_BASE_URL,
    fetch: (request: Request) => {
      attempts.push(request);
      return Promise.resolve(ok());
    },
  });

  client.use(
    newKey === undefined ? createIdempotencyMiddleware() : createIdempotencyMiddleware(newKey),
  );

  return { client, attempts };
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('unsafe methods', () => {
  it('carry a generated key', async () => {
    const { client, attempts } = writeHarness();

    await client.POST('/things', { body: { title: 'x' } });

    expect(attempts[0]?.headers.get(IDEMPOTENCY_KEY_HEADER)).toMatch(UUID_V4);
  });

  it('carry a key on DELETE as well, not only on the method that creates', async () => {
    const { client, attempts } = writeHarness();

    await client.DELETE('/things');

    expect(attempts[0]?.headers.get(IDEMPOTENCY_KEY_HEADER)).toMatch(UUID_V4);
  });

  it('get a different key per logical action', async () => {
    const { client, attempts } = writeHarness();

    await client.POST('/things', { body: { title: 'x' } });
    await client.POST('/things', { body: { title: 'y' } });

    expect(attempts[0]?.headers.get(IDEMPOTENCY_KEY_HEADER)).not.toBe(
      attempts[1]?.headers.get(IDEMPOTENCY_KEY_HEADER),
    );
  });

  /**
   * The point of the header: one logical action keeps one key across every replay of it, so the
   * server can recognise the repeat and return the stored answer instead of doing the work twice.
   * A caller that owns the retry — a mutation the user pressed twice, the replay after a token
   * refresh — supplies the key, and the middleware must not overwrite it.
   */
  it('never overwrite a key the caller chose', async () => {
    const { client, attempts } = writeHarness();

    await client.POST('/things', {
      body: { title: 'x' },
      headers: { [IDEMPOTENCY_KEY_HEADER]: 'caller-owned-key' },
    });

    expect(attempts[0]?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe('caller-owned-key');
  });

  it('use the key source they were given, so the value is testable', async () => {
    const { client, attempts } = writeHarness(() => 'fixed-key');

    await client.POST('/things', { body: { title: 'x' } });

    expect(attempts[0]?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe('fixed-key');
  });
});

/**
 * The order the composition root has to register them in, and the reason it is not a preference.
 *
 * `openapi-fetch` runs `onRequest` in registration order, and the auth middleware clones the request
 * inside its own `onRequest` — that clone is what a replay after a token refresh sends. Registered
 * the other way round, the clone would be taken before the key was attached, and the replay would
 * arrive with a *new* key: two `Idempotency-Key`s for one logical action, which is precisely the
 * duplicate the header exists to prevent, on the one path that is guaranteed to retry.
 */
describe('a replay after a token refresh', () => {
  it('carries the same key as the attempt it replaces', async () => {
    const attempts: Request[] = [];
    const client = createClient<WritePaths>({
      baseUrl: API_BASE_URL,
      fetch: (request: Request) => {
        attempts.push(request);
        return Promise.resolve(attempts.length === 1 ? new Response(null, { status: 401 }) : ok());
      },
    });

    client.use(createIdempotencyMiddleware());
    client.use(
      createAuthMiddleware({
        readAccessToken: () => 'expired',
        refreshSession: () => Promise.resolve({ kind: 'rotated' as const }),
        onSessionLost: () => undefined,
      }),
    );

    await client.POST('/things', { body: { title: 'x' } });

    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe(
      attempts[0]?.headers.get(IDEMPOTENCY_KEY_HEADER),
    );
  });
});

describe('safe methods', () => {
  it('carry no key, because a read has nothing to replay', async () => {
    const attempts: Request[] = [];
    const client = createApiClient({
      baseUrl: API_BASE_URL,
      fetch: (request: Request) => {
        attempts.push(request);
        return Promise.resolve(
          new Response(
            JSON.stringify({ apiVersion: 'v1', serverTime: '2026-07-27T00:00:00.000Z' }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
        );
      },
    });
    client.use(createIdempotencyMiddleware());

    await client.GET('/meta');

    expect(attempts[0]?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBeNull();
  });
});
