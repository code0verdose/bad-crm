import { Router } from 'express';

import { createHealthController } from '@/presentation/http/controllers/health.controller.js';
import { type HttpServerDependencies } from '@/presentation/http/http-server.types.js';

/**
 * The route table of the process.
 *
 * `/health` and `/ready` sit outside `/api/v1` on purpose: they are operational endpoints for the
 * container manager and the load balancer, not part of the product contract, and they are on the
 * explicit allow-list of the OpenAPI contract test (stack.md, «Contract-first флоу»). Product
 * routes are mounted under `/api/v1` from EPIC-005 onwards.
 *
 * Routers are built by a function rather than declared at module scope so that each application
 * instance gets its own — a module-level router would silently share state between the real process
 * and every test that builds an app.
 */
export const createRoutes = (dependencies: HttpServerDependencies): Router => {
  const router = Router();
  const health = createHealthController(dependencies);

  router.get('/health', health.checkHealth);
  router.get('/ready', health.checkReadiness);

  return router;
};
