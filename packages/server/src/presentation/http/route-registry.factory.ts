import { API_PREFIX } from '@/presentation/http/api-version.constant.js';
import { createHealthController } from '@/presentation/http/controllers/health.controller.js';
import { createMetaController } from '@/presentation/http/controllers/meta.controller.js';
import { type HttpServerDependencies } from '@/presentation/http/http-server.types.js';
import { validate } from '@/presentation/http/middleware/validate.middleware.js';
import { type RouteDeclaration } from '@/presentation/http/route-registry.types.js';
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
 * - **EPIC-006 has one place to hang authorization on.** `require-permission.middleware` is mounted
 *   by iterating these declarations, so the guard cannot be forgotten on a new endpoint — the
 *   failure mode a per-route `app.use(requirePermission('task:update'))` invites.
 *
 * `aclCheckedIn` is absent from every entry below because no route here takes a resource id yet.
 * The first one that does is required to name the use-case that performs the ACL check.
 */
export const createRouteRegistry = (
  dependencies: HttpServerDependencies,
): readonly RouteDeclaration[] => {
  const health = createHealthController(dependencies);
  const meta = createMetaController(dependencies);
  const metaQuery = validate({ query: metaQuerySchema });

  return [
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
  ];
};
