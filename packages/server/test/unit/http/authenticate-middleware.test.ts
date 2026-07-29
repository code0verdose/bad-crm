import { type Request, type Response } from 'express';
import { describe, expect, it } from 'vitest';

import { type AuthenticateSessionQuery } from '@/application/identity/use-cases/authenticate-session.query.js';
import { type AuthLookupPort } from '@/application/identity/ports/auth-lookup.port.js';
import { type RefreshTokenPort } from '@/application/identity/ports/refresh-token.port.js';
import {
  type RequestCaller,
  type RequestContext,
  type RequestContextPort,
} from '@/application/platform/ports/request-context.port.js';
import {
  ServiceUnavailableError,
  UnauthenticatedError,
} from '@/domain/shared/errors/app.errors.js';
import {
  createAuthenticationMiddleware,
  readCaller,
} from '@/presentation/http/middleware/authenticate.middleware.js';
import { REFRESH_COOKIE_NAME } from '@/presentation/http/refresh-cookie.util.js';

/**
 * What the guard does with a failure that is **not** "this credential is no good".
 *
 * The distinction is the whole subject of this file. A client that is told 401 follows the contract:
 * it calls `POST /auth/refresh`, is refused again, and clears its session. So a guard that answers
 * 401 to a pool timeout signs an entire organization out of the product because the database was
 * briefly unreachable — and writes no line saying why, because the exception never reached the
 * error handler. A 5xx leaves the session alone and puts the cause in the log, which is the correct
 * outcome of an outage that lasted thirty seconds.
 */

const BEARER = 'access.7c9e6679-7425-40de-944b-e07fc1f90ae7';

const CALLER = {
  userId: 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e',
  organizationId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  sessionId: '1d0f8a2b-6c34-4e51-b8aa-9f2e7c5d31b4',
  familyId: 'f0f0f0f0-6c34-4e51-b8aa-9f2e7c5d31b4',
};

const requestWith = (headers: Record<string, string> = {}): Request =>
  ({ headers, cookies: {} }) as unknown as Request;

const responseStub = (): Response => ({ locals: {} }) as unknown as Response;

/** Runs the middleware and answers with whatever reached `next`. */
const run = async (
  middleware: ReturnType<typeof createAuthenticationMiddleware>,
  request: Request,
  response: Response = responseStub(),
): Promise<unknown> => {
  let received: unknown = 'next() was never called';

  await middleware(request, response, (error?: unknown) => {
    received = error;
  });

  return received;
};

const authenticateWith = (outcome: () => Promise<unknown>): AuthenticateSessionQuery =>
  ({ execute: outcome }) as unknown as AuthenticateSessionQuery;

/** Records what the guard announced, so "the log knows who this is" is an assertion. */
const recordingContext = (): RequestContextPort & { identified: RequestCaller[] } => {
  const identified: RequestCaller[] = [];

  return {
    identified,
    run: <T>(_context: RequestContext, fn: () => T): T => fn(),
    identify: (caller: RequestCaller) => identified.push(caller),
    current: () => undefined,
  };
};

describe('the authentication guard', () => {
  it('establishes the caller when the token verifies', async () => {
    const response = responseStub();
    const middleware = createAuthenticationMiddleware({
      requestContext: recordingContext(),
      authenticate: authenticateWith(() => Promise.resolve(CALLER)),
    });

    const received = await run(
      middleware,
      requestWith({ authorization: `Bearer ${BEARER}` }),
      response,
    );

    expect(received).toBeUndefined();
    expect(readCaller(response)).toEqual(CALLER);
  });

  /**
   * `res.locals` answers "who is this" for the controller of this request and for nothing else. The
   * log lines — including the completion line, written after the handler has returned — read the
   * ambient context, which is why the guard has to announce the caller to both.
   */
  it('announces the caller to the ambient context, not only to res.locals', async () => {
    const requestContext = recordingContext();
    const middleware = createAuthenticationMiddleware({
      requestContext,
      authenticate: authenticateWith(() => Promise.resolve(CALLER)),
    });

    await run(middleware, requestWith({ authorization: `Bearer ${BEARER}` }));

    expect(requestContext.identified).toEqual([
      { organizationId: CALLER.organizationId, userId: CALLER.userId },
    ]);
  });

  it('announces nobody when the credential was refused', async () => {
    const requestContext = recordingContext();
    const middleware = createAuthenticationMiddleware({
      requestContext,
      authenticate: authenticateWith(() => Promise.reject(new UnauthenticatedError())),
    });

    await run(middleware, requestWith({ authorization: `Bearer ${BEARER}` }));

    expect(requestContext.identified).toEqual([]);
  });

  it('refuses a token the query rejected as unusable', async () => {
    const middleware = createAuthenticationMiddleware({
      requestContext: recordingContext(),
      authenticate: authenticateWith(() => Promise.reject(new UnauthenticatedError())),
    });

    const received = await run(middleware, requestWith({ authorization: `Bearer ${BEARER}` }));

    expect(received).toBeInstanceOf(UnauthenticatedError);
  });

  /**
   * The finding this file exists for: `.catch(() => undefined)` treated a pool timeout, a
   * connection reset and any bug inside the query as "the token is no good".
   */
  it.each([
    ['a dependency failure', new ServiceUnavailableError({ dependency: 'postgres' })],
    ['a programming error', new TypeError('cannot read properties of undefined')],
  ])('lets %s through instead of answering 401', async (_case, failure) => {
    const middleware = createAuthenticationMiddleware({
      requestContext: recordingContext(),
      authenticate: authenticateWith(() => Promise.reject(failure)),
    });

    const received = await run(middleware, requestWith({ authorization: `Bearer ${BEARER}` }));

    expect(received).toBe(failure);
    expect(received).not.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('the one route that also accepts the refresh cookie', () => {
  const refreshCredential = (
    record: unknown,
  ): { authLookup: AuthLookupPort; refreshTokens: RefreshTokenPort } => ({
    authLookup: {
      findSessionByRefreshHash: () => Promise.resolve(record),
    } as unknown as AuthLookupPort,
    refreshTokens: { hash: () => new Uint8Array(1) } as unknown as RefreshTokenPort,
  });

  /**
   * A *stale* bearer must fall through to the cookie — that is why signing out survives an expired
   * access token. A *broken* one must not: falling through would answer 401 on the cookie branch and
   * hide the outage behind a refusal, which is the same defect one route further along.
   */
  it('falls through to the cookie when the bearer is merely stale', async () => {
    const response = responseStub();
    const middleware = createAuthenticationMiddleware({
      requestContext: recordingContext(),
      authenticate: authenticateWith(() => Promise.reject(new UnauthenticatedError())),
      refreshCredential: refreshCredential(CALLER),
    });
    const request = {
      headers: { authorization: `Bearer ${BEARER}` },
      cookies: { [REFRESH_COOKIE_NAME]: 'opaque' },
    };

    const received = await run(middleware, request as unknown as Request, response);

    expect(received).toBeUndefined();
    expect(readCaller(response)).toMatchObject({ userId: CALLER.userId });
  });

  it('does not fall through when the bearer failed for an infrastructural reason', async () => {
    const failure = new ServiceUnavailableError({ dependency: 'postgres' });
    const middleware = createAuthenticationMiddleware({
      requestContext: recordingContext(),
      authenticate: authenticateWith(() => Promise.reject(failure)),
      refreshCredential: refreshCredential(CALLER),
    });
    const request = {
      headers: { authorization: `Bearer ${BEARER}` },
      cookies: { [REFRESH_COOKIE_NAME]: 'opaque' },
    };

    await expect(run(middleware, request as unknown as Request)).resolves.toBe(failure);
  });
});
