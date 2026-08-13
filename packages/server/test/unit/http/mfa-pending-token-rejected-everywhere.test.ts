import { randomUUID } from 'node:crypto';

import express, { type Express, type RequestHandler } from 'express';
import { SignJWT } from 'jose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AuthenticateSessionQuery } from '@/application/identity/use-cases/authenticate-session.query.js';
import { type TokenDenylistPort } from '@/application/identity/ports/token-denylist.port.js';
import { JwtAccessTokenAdapter } from '@/infrastructure/crypto/jwt-access-token.adapter.js';
import { JwtMfaPendingTokenAdapter } from '@/infrastructure/crypto/jwt-mfa-pending-token.adapter.js';
import { createErrorHandler } from '@/presentation/http/error-handler.middleware.js';
import { createAuthenticationMiddleware } from '@/presentation/http/middleware/authenticate.middleware.js';
import { API_PREFIX } from '@/presentation/http/api-version.constant.js';
import { createRouteRegistry } from '@/presentation/http/route-registry.factory.js';
import {
  isSelfServiceRoute,
  requiresAuthentication,
  type RouteDeclaration,
} from '@/presentation/http/route-registry.types.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';

import { createTestApp } from '../../support/test-app.util.js';
import {
  FakeClock,
  FakeIdGenerator,
  FakeUnitOfWork,
  FakeSessions,
} from '../../support/identity-doubles.util.js';

/**
 * STORY-013-03 acceptance 3 (`epics/epic-013-two-factor-totp/stories/story-013-03-login-second-factor.md`):
 * an `mfaToken` — the second factor's intermediate credential, `scope = 'mfa_pending'` — must be
 * refused with 401 on every route of `ROUTE_REGISTRY` except `/auth/2fa/verify`, checked by a table
 * test over the *whole* registry rather than a hand-picked sample, so a new route is covered the
 * moment it is added.
 *
 * ## The trap this file exists to not fall into
 *
 * `AuthenticateSessionQuery` verifies a bearer through `AccessTokenPort` (`JwtAccessTokenAdapter` in
 * production), whose `asClaims` already refuses a *genuine* mfa-pending token today — but only
 * because that token carries neither `sid` nor `pv`, both required. That is a coincidence of shape,
 * not a check of scope: a table test that only ever presents a genuine mfa-pending token would stay
 * green even if `authenticate.middleware.ts`'s own explicit scope check were deleted, because
 * `asClaims` would still refuse the token for its missing claims. Table B below is the real access
 * token positive control (proves the table does not reject everything); the final `describe` block
 * is the case that actually falsifies the coincidence — a *forged* token carrying a well-formed
 * `sub`/`org`/`sid`/`pv`, i.e. everything `asClaims` requires, with only `scope` wrong. Removing the
 * middleware's explicit check turns *that* case red; it does not touch Table A, and the report this
 * suite was written for documents exactly that split with the transcripts of both runs.
 *
 * ## Why the table is a purpose-built app rather than the production one
 *
 * The routes here are driven by the real `createRouteRegistry`, so the *set* under test is the real
 * one and a new route is picked up automatically. What answers each request is not the real
 * controller chain, though: those reach Prisma, and this suite (like `route-registry.test.ts` and
 * `public-routes.test.ts` next to it) runs in `pnpm test`, without Postgres. Reaching a controller
 * would turn "the guard let this through" into "the guard let this through, and then a database this
 * process cannot see answered" — a different, non-deterministic assertion. What is under test is the
 * guard's decision, so every guarded route is mounted here behind the real, unmodified
 * `createAuthenticationMiddleware` and a trivial 200 — the same guard-construction logic
 * `route-registry.factory.ts`'s `withAuthenticationGuard` uses, expressed with the exported
 * predicates it uses instead of the private function itself.
 */

const SECRET = 'j'.repeat(32);
const ISSUER = 'bad-crm';
const AUDIENCE = 'bad-crm-api';

const USER_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const FAMILY_ID = 'f0f0f0f0-6c34-4e51-b8aa-9f2e7c5d31b4';
const PERMISSIONS_VERSION = 1;

/** In-memory `TokenDenylistPort`, the same shape `jwt-mfa-pending-token.test.ts` already uses. */
class FakeTokenDenylist implements TokenDenylistPort {
  private readonly revoked = new Set<string>();

  async revoke(key: string): Promise<void> {
    this.revoked.add(key);
  }

  async isRevoked(key: string): Promise<boolean> {
    return this.revoked.has(key);
  }
}

const noopRequestContext = (): RequestContextPort => ({
  run: (_context, fn) => fn(),
  identify: () => {},
  current: () => undefined,
});

/**
 * Every route the real registry mounts the authentication guard on.
 *
 * - A `public: true` route mounts no guard at all (`withAuthenticationGuard` returns it unchanged) —
 *   presenting any bearer there proves nothing about this credential, because none is required.
 * - The one `credential: 'refresh-cookie'` route (`POST /auth/refresh`) is the same: the guard is
 *   never prepended, the handler reads the cookie itself. Presenting the pending token there would
 *   not exercise `authenticate.middleware.ts` either.
 * - Everything else — every `GuardedRoute` and every `SelfServiceRoute` without that one credential
 *   value — has the guard prepended, which is exactly the set this file has to cover.
 */
const guardedRoutes = (): readonly RouteDeclaration[] => {
  const verifyPath = `${API_PREFIX}/auth/2fa/verify`;

  return createRouteRegistry(createTestApp().container.http).filter((route) => {
    // The one route this token is *for*: it authenticates by presenting the token as a body field,
    // not as a bearer credential, so the guard under test never runs for it.
    if (route.path === verifyPath) return false;
    if (!requiresAuthentication(route)) return false;
    if (isSelfServiceRoute(route) && route.credential === 'refresh-cookie') return false;

    return true;
  });
};

const keyOf = (route: RouteDeclaration): string => `${route.method.toUpperCase()} ${route.path}`;

/** `/teams/:teamId/members/:userId` → `/teams/x/members/x` — any concrete segment does, the guard runs first. */
const concretePath = (path: string): string => path.replaceAll(/:[^/]+/g, 'x');

interface Harness {
  readonly app: Express;
  readonly clock: FakeClock;
  readonly sessions: FakeSessions;
  readonly accessTokens: JwtAccessTokenAdapter;
  readonly mfaPendingTokens: JwtMfaPendingTokenAdapter;
}

const buildHarness = (routes: readonly RouteDeclaration[]): Harness => {
  const clock = new FakeClock();
  const sessions = new FakeSessions(clock);
  const unitOfWork = new FakeUnitOfWork();
  const accessTokens = new JwtAccessTokenAdapter(SECRET, clock);
  const mfaPendingTokens = new JwtMfaPendingTokenAdapter(
    SECRET,
    clock,
    new FakeIdGenerator(),
    new FakeTokenDenylist(),
  );
  const authenticate = new AuthenticateSessionQuery(accessTokens, sessions, unitOfWork, clock);
  const guard = createAuthenticationMiddleware({
    authenticate,
    requestContext: noopRequestContext(),
  });

  const stub: RequestHandler = (_request, response) => {
    response.status(200).json({ ok: true });
  };

  const app = express();

  for (const route of routes) {
    app[route.method](concretePath(route.path), guard, stub);
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

  return { app, clock, sessions, accessTokens, mfaPendingTokens };
};

/** Seeds one live session, so a valid access token has a row to be believed against. */
const seedSession = (harness: Harness): void => {
  harness.sessions.rows.set(SESSION_ID, {
    id: SESSION_ID,
    userId: USER_ID,
    familyId: FAMILY_ID,
    rotatedFromId: null,
    refreshTokenHash: new Uint8Array(),
    userAgent: 'vitest',
    ipHash: 'hmac:0.0.0.0',
    ipMasked: '0.0.0.0',
    expiresAt: new Date(harness.clock.now().getTime() + 60_000),
    createdAt: harness.clock.now(),
    revokedAt: null,
    revokedReason: null,
  });
};

const SESSION_ID = randomUUID();

describe('the mfa-pending token — rejected on every guarded route (STORY-013-03 acceptance 3)', () => {
  const routes = guardedRoutes();
  let harness: Harness;
  let mfaPendingToken: string;
  let validAccessToken: string;

  beforeAll(async () => {
    harness = buildHarness(routes);
    seedSession(harness);

    validAccessToken = (
      await harness.accessTokens.issue({
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        sessionId: SESSION_ID,
        permissionsVersion: PERMISSIONS_VERSION,
      })
    ).token;

    mfaPendingToken = (
      await harness.mfaPendingTokens.issue({ userId: USER_ID, organizationId: ORGANIZATION_ID })
    ).token;
  });

  it('covers at least one route, so the table below asserts something', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each(routes.map((route) => [keyOf(route), route] as const))(
    'refuses the pending token with 401 unauthenticated — %s',
    async (_key, route) => {
      const response = await request(harness.app)
        [route.method](concretePath(route.path))
        .set('Authorization', `Bearer ${mfaPendingToken}`);

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('unauthenticated');
    },
  );

  /**
   * **Positive control.** Same table, same routes, a token that is not the second factor's — proves
   * Table A is not passing because the harness rejects everything regardless of the credential.
   */
  it.each(routes.map((route) => [keyOf(route), route] as const))(
    'lets a valid access token reach the route — %s',
    async (_key, route) => {
      const response = await request(harness.app)
        [route.method](concretePath(route.path))
        .set('Authorization', `Bearer ${validAccessToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
    },
  );
});

/**
 * The case that actually distinguishes "the middleware's own scope check runs" from "an unrelated
 * shape check happens to refuse this token too" — see the file doc for why Table A above cannot do
 * this on its own.
 */
describe('isolating the scope check from the asClaims shape coincidence', () => {
  it('refuses a forged token whose only fault is scope=mfa_pending, everything else well-formed', async () => {
    const routes = guardedRoutes();
    const harness = buildHarness(routes);
    seedSession(harness);
    const route = routes[0];
    if (route === undefined)
      throw new Error('unreachable: guardedRoutes() is non-empty (see Table A)');

    const issuedAt = Math.floor(harness.clock.now().getTime() / 1000);
    // Everything `JwtAccessTokenAdapter.asClaims` requires — `sub`, `org`, `sid`, an integer `pv` —
    // matching the same seeded session as the positive control above, plus the one wrong claim.
    const forged = await new SignJWT({
      org: ORGANIZATION_ID,
      sid: SESSION_ID,
      pv: PERMISSIONS_VERSION,
      scope: 'mfa_pending',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(USER_ID)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 900)
      .sign(new TextEncoder().encode(SECRET));

    const response = await request(harness.app)
      [route.method](concretePath(route.path))
      .set('Authorization', `Bearer ${forged}`);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('unauthenticated');
  });

  /** CONTROL: the same forged claims, without the wrong scope, do authenticate — proves the fixture is real. */
  it('CONTROL: the same claims without scope=mfa_pending do authenticate', async () => {
    const routes = guardedRoutes();
    const harness = buildHarness(routes);
    seedSession(harness);
    const route = routes[0];
    if (route === undefined)
      throw new Error('unreachable: guardedRoutes() is non-empty (see Table A)');

    const issuedAt = Math.floor(harness.clock.now().getTime() / 1000);
    const genuine = await new SignJWT({
      org: ORGANIZATION_ID,
      sid: SESSION_ID,
      pv: PERMISSIONS_VERSION,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(USER_ID)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 900)
      .sign(new TextEncoder().encode(SECRET));

    const response = await request(harness.app)
      [route.method](concretePath(route.path))
      .set('Authorization', `Bearer ${genuine}`);

    expect(response.status).toBe(200);
  });
});
