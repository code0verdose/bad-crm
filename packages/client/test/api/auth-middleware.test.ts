import createClient from 'openapi-fetch';
import { describe, expect, it, vi } from 'vitest';

import { AUTH_RETRY_HEADER, createApiClient, createAuthMiddleware } from '@shared/api';

import { API_BASE_URL } from './test-api.util.js';

/** A minimal contract with a body-carrying operation, used only by the replay test below. */
interface ReplayPaths {
  '/echo': {
    post: {
      requestBody: { content: { 'application/json': { hello: string } } };
      responses: { 200: { content: { 'application/json': { apiVersion: string } } } };
    };
  };
}

/**
 * Everything here runs against an injected transport, never a live server: the acceptance of
 * STORY-004-06 is about how many refresh requests a burst of 401s produces, and that number is only
 * observable if the test owns the clock and the responses.
 */
interface Harness {
  readonly client: ReturnType<typeof createApiClient>;
  readonly attempts: () => Request[];
  readonly refreshCalls: () => number;
  readonly resolveRefresh: (token: string | null) => void;
  readonly sessionLost: ReturnType<typeof vi.fn>;
  readonly setToken: (token: string | null) => void;
}

const unauthorized = (): Response =>
  new Response(
    JSON.stringify({
      type: 'https://bad-crm.dev/problems/unauthenticated',
      title: 'Unauthenticated',
      status: 401,
      code: 'unauthenticated',
      requestId: 'req-401',
    }),
    { status: 401, headers: { 'content-type': 'application/problem+json' } },
  );

const meta = (): Response =>
  new Response(JSON.stringify({ apiVersion: 'v1', serverTime: '2026-07-27T09:41:12.004Z' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** Lets every already-queued continuation run before the test looks at the counters. */
const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
};

const harness = (options: {
  respond: (request: Request, attempt: number) => Response;
  token?: string | null;
}): Harness => {
  const attempts: Request[] = [];
  let refreshCalls = 0;
  let resolveRefresh: (token: string | null) => void = () => undefined;
  let token = options.token === undefined ? 'stale-token' : options.token;
  const sessionLost = vi.fn(() => {
    token = null;
  });

  const client = createApiClient({
    baseUrl: API_BASE_URL,
    fetch: (request: Request) => {
      attempts.push(request);
      return Promise.resolve(options.respond(request, attempts.length));
    },
  });

  client.use(
    createAuthMiddleware({
      readAccessToken: () => token,
      refreshSession: () => {
        refreshCalls += 1;
        return new Promise<string | null>((resolve) => {
          resolveRefresh = (value) => {
            if (value !== null) token = value;
            resolve(value);
          };
        });
      },
      onSessionLost: sessionLost,
    }),
  );

  return {
    client,
    attempts: () => attempts,
    refreshCalls: () => refreshCalls,
    resolveRefresh: (value) => {
      resolveRefresh(value);
    },
    sessionLost,
    setToken: (value) => {
      token = value;
    },
  };
};

describe('attaching the access token', () => {
  it('sends the token from memory as a bearer credential', async () => {
    const { client, attempts } = harness({ respond: () => meta() });

    await client.GET('/meta');

    expect(attempts()[0]?.headers.get('authorization')).toBe('Bearer stale-token');
  });

  it('sends no credential when the tab has no session', async () => {
    const { client, attempts } = harness({ respond: () => meta(), token: null });

    await client.GET('/meta');

    expect(attempts()[0]?.headers.get('authorization')).toBeNull();
  });

  it('leaves a successful response alone', async () => {
    const { client, refreshCalls } = harness({ respond: () => meta() });

    const { data } = await client.GET('/meta');

    expect(data?.apiVersion).toBe('v1');
    expect(refreshCalls()).toBe(0);
  });

  it('leaves a failure that is not a 401 alone', async () => {
    const { client, refreshCalls, attempts } = harness({
      respond: () => new Response('{}', { status: 500 }),
    });

    const { response } = await client.GET('/meta');

    expect(response.status).toBe(500);
    expect(refreshCalls()).toBe(0);
    expect(attempts()).toHaveLength(1);
  });
});

/**
 * The acceptance criterion this file exists for: three requests in flight, one expired token, one
 * refresh. Without the shared promise each 401 starts its own `POST /auth/refresh`, the rotating
 * refresh token is spent three times, and reuse detection logs the user out of every device — the
 * failure is not a duplicated request, it is a security response firing at a legitimate user.
 */
describe('a burst of 401s', () => {
  it('produces exactly one refresh and retries every request once', async () => {
    const { client, attempts, refreshCalls, resolveRefresh } = harness({
      respond: (request) => (request.headers.has(AUTH_RETRY_HEADER) ? meta() : unauthorized()),
    });

    const inFlight = [client.GET('/meta'), client.GET('/meta'), client.GET('/meta')];

    await vi.waitFor(() => {
      expect(attempts()).toHaveLength(3);
    });
    await settle();

    expect(refreshCalls()).toBe(1);

    resolveRefresh('fresh-token');
    const results = await Promise.all(inFlight);

    expect(refreshCalls()).toBe(1);
    expect(results.map((result) => result.response.status)).toEqual([200, 200, 200]);
    expect(attempts()).toHaveLength(6);
    expect(
      attempts()
        .slice(3)
        .map((request) => request.headers.get('authorization')),
    ).toEqual(['Bearer fresh-token', 'Bearer fresh-token', 'Bearer fresh-token']);
  });

  it('marks the retry with a header, so the server can tell a replay from a first attempt', async () => {
    const { client, attempts, resolveRefresh } = harness({
      respond: (request) => (request.headers.has(AUTH_RETRY_HEADER) ? meta() : unauthorized()),
    });

    const inFlight = client.GET('/meta');
    await vi.waitFor(() => {
      expect(attempts()).toHaveLength(1);
    });
    resolveRefresh('fresh-token');
    await inFlight;

    expect(attempts()[1]?.headers.get(AUTH_RETRY_HEADER)).toBe('1');
  });

  /**
   * The subtle half of a replay: `fetch(request)` consumes the body, so the original `Request` can
   * never be sent twice. The middleware therefore keeps a clone taken before the send — without it a
   * replayed `POST` arrives with an empty body and the server answers 422 instead of doing the work.
   *
   * `/meta` publishes `get` only, so the body is exercised against a locally declared contract
   * rather than by inventing an operation `docs/api/openapi.yaml` does not have.
   */
  it('preserves the method and the body of the request it replays', async () => {
    const attempts: Request[] = [];
    let resolveRefresh: (token: string | null) => void = () => undefined;
    let token: string | null = 'stale-token';

    const client = createClient<ReplayPaths>({
      baseUrl: API_BASE_URL,
      fetch: (request: Request) => {
        attempts.push(request);
        return Promise.resolve(request.headers.has(AUTH_RETRY_HEADER) ? meta() : unauthorized());
      },
    });

    client.use(
      createAuthMiddleware({
        readAccessToken: () => token,
        refreshSession: () =>
          new Promise<string | null>((resolve) => {
            resolveRefresh = (value) => {
              token = value;
              resolve(value);
            };
          }),
        onSessionLost: () => undefined,
      }),
    );

    const inFlight = client.POST('/echo', { body: { hello: 'world' } });
    await vi.waitFor(() => {
      expect(attempts).toHaveLength(1);
    });
    resolveRefresh('fresh-token');
    await inFlight;

    const replay = attempts[1] as Request;

    expect(replay.method).toBe('POST');
    await expect(replay.text()).resolves.toBe('{"hello":"world"}');
  });
});

describe('the loop protections', () => {
  it('does not start a second refresh when the replay is refused as well', async () => {
    const { client, attempts, refreshCalls, resolveRefresh } = harness({
      respond: () => unauthorized(),
    });

    const inFlight = client.GET('/meta');
    await vi.waitFor(() => {
      expect(attempts()).toHaveLength(1);
    });
    resolveRefresh('fresh-token');
    const { response } = await inFlight;

    expect(response.status).toBe(401);
    expect(refreshCalls()).toBe(1);
    expect(attempts()).toHaveLength(2);
  });

  it('never refreshes for a request that already carries the replay marker', async () => {
    const { client, refreshCalls, attempts } = harness({ respond: () => unauthorized() });

    const { response } = await client.GET('/meta', { headers: { [AUTH_RETRY_HEADER]: '1' } });

    expect(response.status).toBe(401);
    expect(refreshCalls()).toBe(0);
    expect(attempts()).toHaveLength(1);
  });
});

describe('a refresh that fails', () => {
  it('reports the session as lost and returns the original 401', async () => {
    const { client, attempts, sessionLost, resolveRefresh } = harness({
      respond: () => unauthorized(),
    });

    const inFlight = client.GET('/meta');
    await vi.waitFor(() => {
      expect(attempts()).toHaveLength(1);
    });
    resolveRefresh(null);
    const { response } = await inFlight;

    expect(response.status).toBe(401);
    expect(sessionLost).toHaveBeenCalledTimes(1);
    expect(attempts()).toHaveLength(1);
  });

  /**
   * A failed refresh is terminal until somebody signs in again. Without this, every later request of
   * a signed-out tab starts another refresh — a tab left open overnight then hammers the endpoint
   * once per poll.
   */
  it('is not attempted again while the tab has no session', async () => {
    const first = harness({ respond: () => unauthorized() });

    const inFlight = first.client.GET('/meta');
    await vi.waitFor(() => {
      expect(first.attempts()).toHaveLength(1);
    });
    first.resolveRefresh(null);
    await inFlight;

    await first.client.GET('/meta');

    expect(first.refreshCalls()).toBe(1);
  });

  it('is attempted again once a new sign-in has put a token back in memory', async () => {
    const { client, attempts, refreshCalls, resolveRefresh, setToken } = harness({
      respond: () => unauthorized(),
    });

    const inFlight = client.GET('/meta');
    await vi.waitFor(() => {
      expect(attempts()).toHaveLength(1);
    });
    resolveRefresh(null);
    await inFlight;

    setToken('token-from-a-new-login');
    const second = client.GET('/meta');
    await vi.waitFor(() => {
      expect(refreshCalls()).toBe(2);
    });
    resolveRefresh(null);
    await second;

    expect(refreshCalls()).toBe(2);
  });
});

describe('a transport that never answers', () => {
  it('propagates the failure without leaking the request it kept for a replay', async () => {
    let refreshCalls = 0;
    const client = createApiClient({
      baseUrl: API_BASE_URL,
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });

    client.use(
      createAuthMiddleware({
        readAccessToken: () => 'token',
        refreshSession: () => {
          refreshCalls += 1;
          return Promise.resolve(null);
        },
        onSessionLost: () => undefined,
      }),
    );

    await expect(client.GET('/meta')).rejects.toBeInstanceOf(TypeError);
    expect(refreshCalls).toBe(0);
  });
});
