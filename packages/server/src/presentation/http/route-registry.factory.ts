import { API_PREFIX } from '@/presentation/http/api-version.constant.js';
import { createAuthController } from '@/presentation/http/controllers/auth.controller.js';
import { createHealthController } from '@/presentation/http/controllers/health.controller.js';
import { createMetaController } from '@/presentation/http/controllers/meta.controller.js';
import { createSessionController } from '@/presentation/http/controllers/session.controller.js';
import { allowedOrigins } from '@/presentation/http/cors-origin.util.js';
import { type HttpServerDependencies } from '@/presentation/http/http-server.types.js';
import { createAuthenticationMiddleware } from '@/presentation/http/middleware/authenticate.middleware.js';
import { requireIdempotencyKey } from '@/presentation/http/middleware/idempotency-key.middleware.js';
import { createSameOriginMiddleware } from '@/presentation/http/middleware/same-origin.middleware.js';
import { validate } from '@/presentation/http/middleware/validate.middleware.js';
import {
  isSelfServiceRoute,
  requiresAuthentication,
  type RouteDeclaration,
} from '@/presentation/http/route-registry.types.js';
import {
  loginBodySchema,
  registerBodySchema,
  sessionIdParamsSchema,
} from '@/presentation/http/validators/auth.validator.js';
import { metaQuerySchema } from '@/presentation/http/validators/meta.validator.js';

/**
 * Every route this process answers, as data.
 *
 * The registry exists so that "which permission gates this endpoint" has an answer that can be
 * read, tested and reviewed without following a handler chain — invariant 2 of CLAUDE.md and
 * `rules/permissions.mdc` §2. Two properties follow from keeping it as data rather than as calls to
 * `router.get(...)`:
 *
 * - **A route cannot exist without a declaration.** `api.routes.ts` mounts *this list* and nothing
 *   else, so there is no `router.post(...)` for anyone to add somewhere else; the contract test
 *   additionally walks the finished Express router and compares it back, which catches a route
 *   registered outside this file by any other means.
 * - **Authorization has one place to be mounted from.** The authentication guard is prepended below
 *   by asking `requiresAuthentication` about each declaration, so it cannot be forgotten on a new
 *   endpoint — the failure mode a per-route `app.use(...)` invites. The permission guard joins it
 *   the same way in EPIC-011, when the first `GuardedRoute` exists.
 *
 * `aclCheckedIn` is absent from every entry below because no route here is gated by a capability
 * yet. The self-service routes name `ownershipCheckedIn` instead, which the type makes mandatory.
 */
export const createRouteRegistry = (
  dependencies: HttpServerDependencies,
): readonly RouteDeclaration[] => {
  const health = createHealthController(dependencies);
  const meta = createMetaController(dependencies);
  const metaQuery = validate({ query: metaQuerySchema });

  const registerValidator = validate({ body: registerBodySchema });
  const loginValidator = validate({ body: loginBodySchema });
  const sessionIdValidator = validate({ params: sessionIdParamsSchema });

  const auth = createAuthController({
    register: dependencies.identity.register,
    login: dependencies.identity.login,
    refresh: dependencies.identity.refresh,
    endSession: dependencies.identity.endSession,
    registerValidator,
    loginValidator,
  });

  const sessions = createSessionController({
    listSessions: dependencies.identity.listSessions,
    endSession: dependencies.identity.endSession,
    sessionIdValidator,
  });

  const sameOrigin = createSameOriginMiddleware(
    allowedOrigins({
      appUrl: dependencies.config.appUrl,
      extraOrigins: dependencies.config.corsExtraOrigins,
    }),
  );

  const declarations: readonly RouteDeclaration[] = [
    {
      method: 'get',
      path: '/health',
      handlers: [health.checkHealth],
      public: true,
      publicReason:
        'liveness probe of the container manager; it runs before any session exists and returns no tenant data',
    },
    {
      method: 'get',
      path: '/ready',
      handlers: [health.checkReadiness],
      public: true,
      publicReason:
        'readiness probe of the load balancer; gating it on a session would take the instance out of rotation whenever auth is degraded',
    },
    {
      method: 'get',
      path: `${API_PREFIX}/meta`,
      handlers: [metaQuery.handler, meta.describeApi],
      public: true,
      publicReason:
        'API discovery: the client reads the version and the server clock before it has a session, and the response contains no tenant data',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/register`,
      handlers: [requireIdempotencyKey(), registerValidator.handler, auth.register],
      public: true,
      publicReason:
        'bootstrap of an empty installation: the subject a permission would be checked against is created by this very request; bounded by the installation-wide open-registration setting and by the organization_registration budget of three per hour per address, spent in RegisterOrganizationUseCase before anything is hashed or written',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/login`,
      handlers: [loginValidator.handler, auth.login],
      public: true,
      publicReason:
        'sign-in itself: the session a permission would be read from is what this operation issues; bounded by the auth_attempt budget of five per fifteen minutes on the pair of address and account, spent in LoginUseCase before any digest is verified and cleared once a session is issued',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/refresh`,
      handlers: [sameOrigin, auth.refresh],
      // Not `public`, and the distinction is the reason the third form exists: the caller is
      // authorised by possession of the refresh cookie, so the route is not anonymous — it simply
      // has no capability to check. Declaring it public would state that credentials are optional
      // here, which is the opposite of the truth.
      selfService: true,
      selfServiceReason:
        'authorised by possession of the refresh cookie, which identifies one session of one person; there is no capability to check, and the account has no say over its own session rotation',
      ownershipCheckedIn: 'RefreshSessionUseCase',
      credential: 'refresh-cookie',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/logout`,
      handlers: [auth.logout],
      selfService: true,
      selfServiceReason:
        'ending one’s own session is not a capability anybody can be denied; the subject and the object are the same person',
      ownershipCheckedIn: 'EndSessionUseCase.signOut',
      credential: 'either',
    },
    {
      method: 'get',
      path: `${API_PREFIX}/auth/sessions`,
      handlers: [sessions.list],
      selfService: true,
      selfServiceReason:
        'reading one’s own sessions; the administrator’s right over another person’s sessions is a different operation and belongs to the permission catalog of EPIC-011',
      ownershipCheckedIn: 'ListSessionsQuery',
    },
    {
      method: 'delete',
      path: `${API_PREFIX}/auth/sessions/:sessionId`,
      handlers: [sessionIdValidator.handler, sessions.revoke],
      selfService: true,
      selfServiceReason:
        'closing one’s own session; ownership is the check, and it is made in the use-case by matching the session against the caller rather than by a capability',
      ownershipCheckedIn: 'EndSessionUseCase.revoke',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/sessions/revoke-others`,
      handlers: [sessions.revokeOthers],
      selfService: true,
      selfServiceReason:
        'same subject and object as signing out, over the rest of one’s own sessions; there is no capability that could grant it to anybody else',
      ownershipCheckedIn: 'EndSessionUseCase.revokeOthers',
    },
  ];

  return declarations.map((route) => withAuthenticationGuard(route, dependencies));
};

/**
 * Prepends the authentication guard to every declaration that is not public.
 *
 * Derived from the declaration rather than written into `handlers` by each route author: that is
 * what makes "a route without a guard" impossible to produce by forgetting, and it is why
 * `requiresAuthentication` is a predicate over the union rather than a comment.
 *
 * The single exception is stated by the declaration itself and not by this function:
 * `credential: 'refresh-cookie'` means the handler consumes the credential, so a guard in front of
 * it would read the same row a second time and answer 401 without clearing the cookie.
 */
const withAuthenticationGuard = (
  route: RouteDeclaration,
  dependencies: HttpServerDependencies,
): RouteDeclaration => {
  if (!requiresAuthentication(route)) return route;

  const credential = isSelfServiceRoute(route) ? route.credential : undefined;

  if (credential === 'refresh-cookie') return route;

  const guard = createAuthenticationMiddleware({
    authenticate: dependencies.identity.authenticate,
    requestContext: dependencies.requestContext,
    ...(credential === 'either'
      ? {
          refreshCredential: {
            authLookup: dependencies.identity.authLookup,
            refreshTokens: dependencies.identity.refreshTokens,
          },
        }
      : {}),
  });

  return { ...route, handlers: [guard, ...route.handlers] };
};
