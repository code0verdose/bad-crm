/**
 * Paths that are allowed to exist without an operation in `docs/api/openapi.yaml`.
 *
 * The list lives in the test tree, not in a configuration file, so that adding an exception is a
 * line in a reviewed diff next to the assertion it weakens (ADR-0003, «Проверяемость»). Each entry
 * carries the reason it is not part of the product contract; an entry without one is an endpoint
 * somebody wanted to ship undocumented.
 *
 * Exact paths only — no prefixes and no patterns. A mask such as `/internal/**` would silently
 * exempt every endpoint anybody ever puts under it, which is how an allow-list stops being one.
 */
export const SERVICE_ROUTE_ALLOW_LIST: readonly { path: string; reason: string }[] = [
  {
    path: '/health',
    reason:
      'liveness probe of the container manager; it answers before the process is useful and is not a product operation',
  },
  {
    path: '/ready',
    reason:
      'readiness probe of the load balancer; its body describes dependencies of this instance, not data of the product',
  },
  {
    path: '/metrics',
    reason:
      'Prometheus scrape endpoint (EPIC-009); OpenAPI cannot describe the exposition format, and it is never called by a client',
  },
  {
    path: '/socket.io',
    reason:
      'Socket.IO handshake (EPIC-025); realtime events are contracted in packages/shared/src/realtime, not in OpenAPI',
  },
];

export const isAllowedServiceRoute = (path: string): boolean =>
  SERVICE_ROUTE_ALLOW_LIST.some((entry) => entry.path === path);
