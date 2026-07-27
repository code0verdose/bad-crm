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
 * The declaration of one route.
 *
 * A union rather than an interface with two optional fields, so that "a route with neither a
 * permission nor a stated reason" is a compile error rather than something a test has to catch —
 * invariant 2 of CLAUDE.md made structural. The registry is also the seam EPIC-006 hangs
 * `require-permission.middleware` on: it can iterate declarations and mount the guard itself,
 * instead of every route author remembering to add it.
 */
export type RouteDeclaration = GuardedRoute | PublicRoute;

export const isPublicRoute = (route: RouteDeclaration): route is PublicRoute => 'public' in route;

export const isGuardedRoute = (route: RouteDeclaration): route is GuardedRoute =>
  !isPublicRoute(route);
