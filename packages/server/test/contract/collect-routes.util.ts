import { type Express } from 'express';

/** One route as both sides of the comparison spell it: `GET /api/v1/meta`. */
export interface CollectedRoute {
  readonly method: string;
  readonly path: string;
}

interface ExpressRoute {
  path?: unknown;
  methods?: Record<string, boolean>;
}

interface ExpressLayer {
  route?: ExpressRoute;
  handle?: { stack?: ExpressLayer[] };
}

/**
 * `/things/:thingId` and `/things/{taskId}` both become `/things/{param}`.
 *
 * The two sides write parameters in different syntaxes and, more importantly, are free to name them
 * differently: the specification may say `{taskId}` while the handler destructures `:id`. Only the
 * *shape* is comparable, so the name is normalised away — a route and an operation match when their
 * static segments and their arity agree, which is exactly what a caller can observe.
 */
export const normalizePath = (path: string): string =>
  path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) return '{param}';

      return segment.startsWith('{') && segment.endsWith('}') ? '{param}' : segment;
    })
    .join('/');

const routesOf = (layers: readonly ExpressLayer[]): CollectedRoute[] =>
  layers.flatMap((layer) => {
    if (layer.handle?.stack !== undefined) return routesOf(layer.handle.stack);
    if (layer.route === undefined || typeof layer.route.path !== 'string') return [];

    const path = layer.route.path;

    return Object.entries(layer.route.methods ?? {})
      .filter(([, enabled]) => enabled)
      .map(([method]) => ({ method: method.toUpperCase(), path }));
  });

/**
 * Every route the finished Express application actually answers.
 *
 * Read out of the router rather than out of the registry on purpose: the registry is what the
 * authors *declared*, and this is what the process *serves*. Comparing the two is what catches a
 * route mounted by any other means — a `router.get(...)` added to `api.routes.ts`, a third-party
 * middleware that registers its own endpoint.
 *
 * One structural assumption, and it is checked by the suite that uses this helper: routers are
 * mounted without a path prefix, with each declaration carrying its full path. Express 5 does not
 * expose the mount prefix of a sub-router to introspection, so `app.use('/api/v1', router)` would
 * yield `/meta` here and quietly mismatch the specification.
 */
export const collectRoutes = (app: Express): CollectedRoute[] =>
  routesOf((app.router as unknown as { stack: ExpressLayer[] }).stack)
    .map((route) => ({ method: route.method, path: normalizePath(route.path) }))
    .sort((left, right) =>
      `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`),
    );

export const routeKey = (route: CollectedRoute): string => `${route.method} ${route.path}`;
