import { type PermissionKey } from '@bad-crm/shared/permissions';
import { type RequestHandler } from 'express';

/** The methods this API uses. `head` and `options` are answered by Express, not declared here. */
export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

interface RouteBase {
  readonly method: HttpMethod;
  /**
   * The Express path, including the `/api/v1` prefix for product operations.
   *
   * Written in full rather than assembled from a mounted sub-router on purpose: Express 5 does not
   * expose the prefix of a mounted router to introspection, so `app.use('/api/v1', router)` would
   * make the contract test compare `/tasks` against `/api/v1/tasks` and drift silently.
   */
  readonly path: string;
  /** Validator middleware first, controller last. */
  readonly handlers: readonly RequestHandler[];
}

/** A route gated by a capability from the closed catalog in `packages/shared`. */
export interface GuardedRoute extends RouteBase {
  readonly permission: PermissionKey;
  /**
   * Name of the use-case that performs the resource-level ACL check.
   *
   * Required by `rules/permissions.mdc` §3 for every route with an id parameter: the capability is
   * a fail-fast filter, and the authoritative decision — the one that also has to answer 404 rather
   * than 403 for another organization — lives in the use-case.
   */
  readonly aclCheckedIn?: string;
}

/** A route deliberately reachable without a permission, with the reason recorded in the diff. */
export interface PublicRoute extends RouteBase {
  readonly public: true;
  /** Why this route needs no permission. Reviewed on every change; a stock phrase is not one. */
  readonly publicReason: string;
}

/**
 * A route the caller reaches on their own behalf: authenticated, and authorised by ownership.
 *
 * The category is not an escape hatch invented here. `docs/security/permission-model.md` §3.20
 * already records it for a person's own key pair — an action whose subject and object are the same
 * person is verified by knowing the secret or owning the row, and checking a capability for it is
 * meaningless in both directions: taking the right away would not stop them, and granting it to
 * somebody else would give access to nothing. EPIC-006 is the second family of it: closing one's
 * own session, listing one's own devices, changing one's own password.
 *
 * Neither existing form fits, and the wrong one is worse than it looks:
 *
 * - `GuardedRoute` needs a key from the closed catalog, and no key means "over yourself"
 *   (`user:read_sessions` in `docs/security/permission-model.md` §3 is the administrator's right
 *   over *another* person's sessions — a different operation, with a different answer for a
 *   stranger's id);
 * - `PublicRoute` would be a lie in the direction that costs something. `public: true` is what the
 *   authentication guard reads to decide it is not needed, so declaring `GET /auth/sessions` public
 *   removes authentication from a route whose entire semantics is "the caller's own" — and it would
 *   pass every test in this repository, because nothing here can tell a deliberate exemption from a
 *   mistaken one.
 *
 * Hence the third member, with `ownershipCheckedIn` **required** where `aclCheckedIn` is optional:
 * this is the obvious place to hide an endpoint that should have carried a permission, so it has to
 * name the use-case that verifies the caller owns the resource — the same check that answers 404
 * rather than 403 for somebody else's session id.
 */
export interface SelfServiceRoute extends RouteBase {
  readonly selfService: true;
  /**
   * Why no capability applies. Same standard as `publicReason`: a reviewer has to be able to
   * disagree with it, which a stock phrase gives them nothing to do.
   */
  readonly selfServiceReason: string;
  /**
   * Name of the use-case or query that proves the caller owns the resource.
   *
   * Required rather than optional because the permission guard is skipped here: with no capability
   * and no named ownership check, nothing at all decides who may call the route.
   */
  readonly ownershipCheckedIn: string;
}

/**
 * The declaration of one route.
 *
 * A union rather than an interface with optional fields, so that "a route with neither a permission
 * nor a stated reason" is a compile error rather than something a test has to catch — invariant 2
 * of CLAUDE.md made structural. The registry is also the seam EPIC-006 hangs
 * `require-permission.middleware` on: it can iterate declarations and mount the guard itself,
 * instead of every route author remembering to add it.
 */
export type RouteDeclaration = GuardedRoute | PublicRoute | SelfServiceRoute;

export const isPublicRoute = (route: RouteDeclaration): route is PublicRoute => 'public' in route;

export const isSelfServiceRoute = (route: RouteDeclaration): route is SelfServiceRoute =>
  'selfService' in route;

export const isGuardedRoute = (route: RouteDeclaration): route is GuardedRoute =>
  !isPublicRoute(route) && !isSelfServiceRoute(route);

/**
 * The three ways a route may state who is allowed to call it, spelled as the specification spells
 * them: `x-permission`, `x-public-reason`, `x-self-service-reason`.
 *
 * One vocabulary for both sides, so that `packages/server/test/contract/openapi.test.ts` can
 * compare the registry with `docs/api/openapi.yaml` in both directions rather than translating
 * between two private ones.
 */
export const AUTHORIZATION_FORMS = ['permission', 'public', 'self-service'] as const;

export type AuthorizationForm = (typeof AUTHORIZATION_FORMS)[number];

export const authorizationFormOf = (route: RouteDeclaration): AuthorizationForm => {
  if (isPublicRoute(route)) return 'public';

  return isSelfServiceRoute(route) ? 'self-service' : 'permission';
};

/**
 * Whether the authentication guard is mounted for this route — everything but a public one.
 *
 * The distinction the self-service form exists to keep: it drops the *permission* guard and nothing
 * else. A predicate rather than a comment because EPIC-006 mounts the middleware by iterating the
 * registry, and "self-service also needs a session" is then a property of the code instead of
 * something the next route author has to have read.
 */
export const requiresAuthentication = (route: RouteDeclaration): boolean => !isPublicRoute(route);

/** Whether the permission guard is mounted — only a route that names a capability. */
export const requiresPermission = (route: RouteDeclaration): boolean => isGuardedRoute(route);
