import { type Request, type RequestHandler, type Response } from 'express';

import {
  type AuthenticatedCaller,
  type AuthenticateSessionQuery,
} from '@/application/identity/use-cases/authenticate-session.query.js';
import { type AuthLookupPort } from '@/application/identity/ports/auth-lookup.port.js';
import { type RefreshTokenPort } from '@/application/identity/ports/refresh-token.port.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import { UnauthenticatedError } from '@/domain/shared/errors/app.errors.js';
import { readRefreshCookie } from '@/presentation/http/refresh-cookie.util.js';

/**
 * Where the caller lives between the guard and the controller — `res.locals` under a symbol, the
 * same slot mechanism `validate.middleware.ts` uses and for the same reason: a string key collides
 * with whatever else writes to `locals`.
 */
const CALLER = Symbol.for('bad-crm.authenticated-caller');

type CallerLocals = Record<symbol, unknown>;

const BEARER = /^Bearer (?<token>[\w.\-+/=]+)$/;

/** The bearer token of the request, or `undefined` when there is not exactly one well-formed one. */
export const readBearerToken = (request: Request): string | undefined => {
  const header = request.headers.authorization;

  if (typeof header !== 'string') return undefined;

  return BEARER.exec(header)?.groups?.['token'];
};

export interface AuthenticationDependencies {
  readonly authenticate: AuthenticateSessionQuery;
  /**
   * Where the caller is announced to everything that logs.
   *
   * Not optional, deliberately. `res.locals` answers "who is this" for the controller and for
   * nothing else, and for two months every line of every authenticated request carried
   * `organizationId: null, userId: null` because that was the only place the guard wrote to
   * (`rules/observability.mdc`, rule 2). Making the port a required dependency means a guard
   * mounted without it does not compile.
   */
  readonly requestContext: RequestContextPort;
  /**
   * Present only on the routes whose contract declares `refreshCookie` as an alternative security
   * scheme — today `POST /auth/logout` alone.
   *
   * It is a *deliberate* widening of one endpoint and not a general one: the cookie is scoped to
   * `Path=/api/v1/auth`, so it reaches every operation of this group, and accepting it everywhere
   * would make each of them reachable with an ambient credential. Signing out is the one place where
   * refusing it would be worse than accepting it — an expired access token must not make it
   * impossible to close a session, which is exactly the moment somebody wants to.
   */
  readonly refreshCredential?: {
    readonly authLookup: AuthLookupPort;
    readonly refreshTokens: RefreshTokenPort;
  };
}

/**
 * The guard mounted on every route the registry does not mark public.
 *
 * It is mounted by iterating the registry rather than by each route author remembering it
 * (`route-registry.factory.ts`), which is the whole reason the registry is data: a new endpoint
 * cannot be added without a declaration, and the declaration is what decides whether this runs.
 *
 * The refusal is a plain `unauthenticated`, identical for a missing header, a malformed one, a bad
 * signature, an expired token and a revoked session. The client has the same thing to do in every
 * case — refresh, then sign in — and a reason carried out here is a reason in a response body.
 */
export const createAuthenticationMiddleware = (
  dependencies: AuthenticationDependencies,
): RequestHandler => {
  return async (request, response, next) => {
    try {
      const caller = await resolveCaller(dependencies, request);

      if (caller === undefined) {
        next(new UnauthenticatedError());

        return;
      }

      (response.locals as CallerLocals)[CALLER] = caller;
      // Two destinations for one fact, and neither is redundant: `res.locals` is read by the
      // controller of this request, the ambient context by every log line of it — including the
      // completion line, which is written after the handler has returned and can read nothing from
      // a local.
      dependencies.requestContext.identify({
        organizationId: caller.organizationId,
        userId: caller.userId,
      });
      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * The caller behind a bearer token, or `undefined` when the token is no good.
 *
 * **Only `UnauthenticatedError` means "no good".** Everything else — a pool timeout, a connection
 * reset, a bug inside the query — is rethrown and becomes a 5xx.
 *
 * The blanket `.catch(() => undefined)` that used to stand here was not a smaller version of this:
 * a client that receives 401 does what the contract tells it to, which is to refresh and, on a
 * second 401, clear its session. So half a minute of an unreachable database answered 401 to every
 * request and signed an entire organization out of the product — with no line in the log about the
 * cause, because the exception never reached the error handler. A 5xx is a client that waits and a
 * log line that says what happened.
 */
const callerFromBearer = async (
  dependencies: AuthenticationDependencies,
  bearer: string,
): Promise<AuthenticatedCaller | undefined> => {
  try {
    return await dependencies.authenticate.execute(bearer);
  } catch (error) {
    if (error instanceof UnauthenticatedError) return undefined;

    throw error;
  }
};

/**
 * Bearer first, cookie second.
 *
 * The order matters on the one route that accepts both: a browser holding a *stale* access token and
 * a live cookie has to end up signing out rather than being refused, so a bearer that does not
 * verify falls through instead of deciding the answer. A bearer that failed *infrastructurally* does
 * not fall through — that would answer 401 on the cookie branch and hide the outage behind a
 * refusal, which is the same defect one route further along.
 */
const resolveCaller = async (
  dependencies: AuthenticationDependencies,
  request: Request,
): Promise<AuthenticatedCaller | undefined> => {
  const bearer = readBearerToken(request);

  if (bearer !== undefined) {
    const caller = await callerFromBearer(dependencies, bearer);

    if (caller !== undefined) return caller;
  }

  const cookie = dependencies.refreshCredential;
  const presented = cookie === undefined ? undefined : readRefreshCookie(request);

  if (cookie === undefined || presented === undefined) return undefined;

  const record = await cookie.authLookup.findSessionByRefreshHash(
    cookie.refreshTokens.hash(presented),
  );

  // A revoked row still identifies its own session, and signing out of an already closed session is
  // the idempotent 204 the contract promises. A token nobody ever issued identifies nothing.
  return record === null
    ? undefined
    : {
        userId: record.userId,
        organizationId: record.organizationId,
        sessionId: record.sessionId,
        familyId: record.familyId,
      };
};

/**
 * The caller established by the guard.
 *
 * Throws rather than returning `undefined` when the guard did not run: a controller that reads this
 * is a controller behind an authenticated route, and "no caller" there is a wiring defect that must
 * not degrade into an anonymous request.
 */
export const readCaller = (response: Response): AuthenticatedCaller => {
  const caller = (response.locals as CallerLocals)[CALLER];

  if (caller === undefined) {
    throw new Error('authenticate.middleware: no caller — the route was mounted without the guard');
  }

  return caller as AuthenticatedCaller;
};
