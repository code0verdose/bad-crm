/** What an unmatched request is reported as, in logs and later in metric labels. */
export const UNMATCHED_ROUTE = 'unmatched';

/** The parts of an Express request this module reads — declared so tests need no real request. */
export interface RoutableRequest {
  readonly baseUrl?: string;
  readonly route?: { readonly path?: string };
  readonly originalUrl?: string;
}

/**
 * The route **template** of a request: `/api/v1/tasks/:taskId`, never `/api/v1/tasks/01J8Z…`.
 *
 * Two failures are avoided by never falling back to the URL:
 *
 * 1. **Cardinality.** `route` becomes a metric label (EPIC-009); one label value per identifier
 *    turns a histogram into an unbounded memory leak (rules/observability.mdc, rule 9).
 * 2. **Secrets in the path.** An unmatched request is usually a typo or a probe — and this product
 *    has routes whose path segment *is* the credential (`/l/:token` for protected links). Logging
 *    the raw URL of unmatched requests would copy those tokens into every aggregator.
 */
export const routeTemplateOf = (request: RoutableRequest): string => {
  const path = request.route?.path;

  if (path === undefined) return UNMATCHED_ROUTE;

  const template = `${request.baseUrl ?? ''}${path}`;

  return template.length > 1 && template.endsWith('/') ? template.slice(0, -1) : template;
};
