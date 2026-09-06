import { randomUUID } from 'node:crypto';

import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AuthenticateSessionQuery } from '@/application/identity/use-cases/authenticate-session.query.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import { JwtAccessTokenAdapter } from '@/infrastructure/crypto/jwt-access-token.adapter.js';
import { API_PREFIX } from '@/presentation/http/api-version.constant.js';
import { createErrorHandler } from '@/presentation/http/error-handler.middleware.js';
import { createAuthenticationMiddleware } from '@/presentation/http/middleware/authenticate.middleware.js';
import { createFullSessionMiddleware } from '@/presentation/http/middleware/require-full-session.middleware.js';
import { createRouteRegistry } from '@/presentation/http/route-registry.factory.js';
import {
  requiresAuthentication,
  requiresFullSession,
  type RouteDeclaration,
} from '@/presentation/http/route-registry.types.js';

import { createTestApp } from '../../support/test-app.util.js';
import { FakeClock, FakeSessions, FakeUnitOfWork } from '../../support/identity-doubles.util.js';

/**
 * STORY-013-05 acceptance 3: a session the organization's second-factor policy scoped to enrolment
 * (`scope = 'mfa_enrollment'`) may reach **only** the TOTP setup routes and sign-out; every other
 * route of `ROUTE_REGISTRY` answers 403 `mfa_enrollment_required`.
 *
 * Table-driven over the *whole* registry rather than over a hand-picked sample, for the reason its
 * sibling `mfa-pending-token-rejected-everywhere.test.ts` gives: a route added next month is covered
 * the day it is declared, and the whitelist can only grow by somebody writing
 * `mfaEnrollmentAllowed: true` in the diff, which is a line a reviewer sees.
 *
 * ## Three tables, and the second is what makes the first mean something
 *
 * - **A.** Every route the gate is mounted on refuses the scoped token — 403, and with this code
 *   rather than the 401 an ordinary refusal would give.
 * - **B.** The positive control. The *same* routes, the *same* harness, an ordinary access token:
 *   they answer 200. Without it, table A would also pass on a harness that refuses everything.
 * - **C.** The whitelist, asserted as a set rather than as a property of each route. This is the
 *   assertion that fails if somebody adds `mfaEnrollmentAllowed: true` to a fourth route: tables A
 *   and B would happily shrink and grow with it, because they are derived from the same predicate
 *   the production code uses.
 *
 * The harness mounts the real guards over a stub handler, exactly as its sibling does and for the
 * same reason: what is under test is the gate's decision, and reaching a controller would need a
 * database this suite does not have.
 */

const SECRET = 'j'.repeat(32);

const USER_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const FAMILY_ID = 'f0f0f0f0-6c34-4e51-b8aa-9f2e7c5d31b4';
const SESSION_ID = randomUUID();
const PERMISSIONS_VERSION = 1;

const noopRequestContext = (): RequestContextPort => ({
  run: (_context, fn) => fn(),
  identify: () => {},
  current: () => undefined,
});

const registry = (): readonly RouteDeclaration[] =>
  createRouteRegistry(createTestApp().container.http);

/** Every route the enrolment gate is actually mounted on, taken from the production predicate. */
const gatedRoutes = (): readonly RouteDeclaration[] => registry().filter(requiresFullSession);

const keyOf = (route: RouteDeclaration): string => `${route.method.toUpperCase()} ${route.path}`;

const concretePath = (path: string): string => path.replaceAll(/:[^/]+/g, 'x');

interface Harness {
  readonly app: Express;
  readonly accessTokens: JwtAccessTokenAdapter;
}

const buildHarness = (routes: readonly RouteDeclaration[]): Harness => {
  const clock = new FakeClock();
  const sessions = new FakeSessions(clock);
  const accessTokens = new JwtAccessTokenAdapter(SECRET, clock);
  const authenticate = new AuthenticateSessionQuery(
    accessTokens,
    sessions,
    new FakeUnitOfWork(),
    clock,
  );

  sessions.rows.set(SESSION_ID, {
    id: SESSION_ID,
    userId: USER_ID,
    familyId: FAMILY_ID,
    rotatedFromId: null,
    refreshTokenHash: new Uint8Array(),
    userAgent: 'vitest',
    ipHash: 'hmac:0.0.0.0',
    ipMasked: '0.0.0.0',
    expiresAt: new Date(clock.now().getTime() + 60_000),
    createdAt: clock.now(),
    revokedAt: null,
    revokedReason: null,
  });

  const guard = createAuthenticationMiddleware({
    authenticate,
    requestContext: noopRequestContext(),
  });

  const stub: RequestHandler = (_request, response) => {
    response.status(200).json({ ok: true });
  };

  const app = express();

  for (const route of routes) {
    app[route.method](concretePath(route.path), guard, createFullSessionMiddleware(), stub);
  }

  app.use(
    createErrorHandler({
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this;
        },
      },
      requestContext: noopRequestContext(),
    }),
  );

  return { app, accessTokens };
};

describe('the mfa-enrollment scope — refused on every gated route (STORY-013-05 acceptance 3)', () => {
  const routes = gatedRoutes();
  let harness: Harness;
  let scopedToken: string;
  let ordinaryToken: string;

  beforeAll(async () => {
    harness = buildHarness(routes);

    const claims = {
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      sessionId: SESSION_ID,
      permissionsVersion: PERMISSIONS_VERSION,
    };

    scopedToken = (await harness.accessTokens.issue({ ...claims, mfaEnrollment: true })).token;
    ordinaryToken = (await harness.accessTokens.issue({ ...claims, mfaEnrollment: false })).token;
  });

  it('covers at least one route, so the tables below assert something', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each(routes.map((route) => [keyOf(route), route] as const))(
    'refuses the scoped token with 403 mfa_enrollment_required — %s',
    async (_key, route) => {
      const response = await request(harness.app)
        [route.method](concretePath(route.path))
        .set('Authorization', `Bearer ${scopedToken}`);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('mfa_enrollment_required');
    },
  );

  /** Positive control — the same routes, a token without the scope, all the way through. */
  it.each(routes.map((route) => [keyOf(route), route] as const))(
    'lets an ordinary access token reach the route — %s',
    async (_key, route) => {
      const response = await request(harness.app)
        [route.method](concretePath(route.path))
        .set('Authorization', `Bearer ${ordinaryToken}`);

      expect(response.status).toBe(200);
    },
  );
});

describe('the whitelist itself', () => {
  it('is exactly TOTP setup, TOTP confirm and sign-out', () => {
    const allowed = registry()
      .filter((route) => route.mfaEnrollmentAllowed === true)
      .map(keyOf)
      .sort();

    expect(allowed).toEqual(
      [
        `POST ${API_PREFIX}/auth/2fa/confirm`,
        `POST ${API_PREFIX}/auth/2fa/setup`,
        `POST ${API_PREFIX}/auth/logout`,
      ].sort(),
    );
  });

  it('never marks a public route: nothing about a credential applies where none is required', () => {
    const publicAllowed = registry().filter(
      (route) => route.mfaEnrollmentAllowed === true && !requiresAuthentication(route),
    );

    expect(publicAllowed).toEqual([]);
  });

  /**
   * The one authenticated route the gate is *not* mounted on, named here rather than left implicit:
   * `POST /auth/refresh` has no authentication guard either — the handler consumes the cookie — so
   * there is no caller to read. It is not a hole: the rotation re-decides the scope, which is how a
   * role granted an hour ago takes effect on the next refresh.
   */
  it('mounts the gate on every authenticated route but the cookie-consuming refresh', () => {
    const ungated = registry()
      .filter(requiresAuthentication)
      .filter((route) => !requiresFullSession(route) && route.mfaEnrollmentAllowed !== true)
      .map(keyOf);

    expect(ungated).toEqual([`POST ${API_PREFIX}/auth/refresh`]);
  });
});
