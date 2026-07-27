import { Router } from 'express';

import { type HttpServerDependencies } from '@/presentation/http/http-server.types.js';
import { createRouteRegistry } from '@/presentation/http/route-registry.factory.js';

/**
 * The route table of the process, mounted from `route-registry.factory.ts` and from nothing else.
 *
 * No route is registered by hand here, on purpose. A route added with a bare `router.get(...)`
 * would carry no permission declaration and no stated reason for being public — exactly the
 * omission invariant 2 of CLAUDE.md is about — so mounting from the registry makes the declaration
 * the only way to get a route at all. `test/contract/openapi.test.ts` closes the loop from the
 * other side by walking the finished Express router and comparing it back to the registry and to
 * the specification.
 *
 * `/health` and `/ready` sit outside `/api/v1` on purpose: they are operational endpoints for the
 * container manager and the load balancer, not part of the product contract, and they are on the
 * explicit allow-list of the OpenAPI contract test (stack.md, «Contract-first флоу»).
 *
 * Routers are built by a function rather than declared at module scope so that each application
 * instance gets its own — a module-level router would silently share state between the real process
 * and every test that builds an app.
 */
export const createRoutes = (dependencies: HttpServerDependencies): Router => {
  const router = Router();

  for (const route of createRouteRegistry(dependencies)) {
    router[route.method](route.path, ...route.handlers);
  }

  return router;
};
