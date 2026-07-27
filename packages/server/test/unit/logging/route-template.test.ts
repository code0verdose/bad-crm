import { describe, expect, it } from 'vitest';

import {
  UNMATCHED_ROUTE,
  routeTemplateOf,
} from '../../../src/infrastructure/logging/route-template.util.js';

describe('route template of a request', () => {
  it('joins the mount path with the route pattern, keeping the parameter names', () => {
    expect(
      routeTemplateOf({
        baseUrl: '/api/v1/tasks',
        route: { path: '/:taskId' },
        originalUrl: '/api/v1/tasks/01J8Z2F5',
      }),
    ).toBe('/api/v1/tasks/:taskId');
  });

  it('handles a route mounted at the application root', () => {
    expect(
      routeTemplateOf({ baseUrl: '', route: { path: '/health' }, originalUrl: '/health' }),
    ).toBe('/health');
  });

  it('keeps the root route as "/" rather than trimming it to an empty string', () => {
    expect(routeTemplateOf({ baseUrl: '', route: { path: '/' }, originalUrl: '/' })).toBe('/');
  });

  it('does not double the slash when the pattern is the mount point itself', () => {
    expect(
      routeTemplateOf({
        baseUrl: '/api/v1/tasks',
        route: { path: '/' },
        originalUrl: '/api/v1/tasks',
      }),
    ).toBe('/api/v1/tasks');
  });

  /**
   * Two reasons never to fall back to the URL, and the second one is the serious one:
   *
   * 1. Cardinality — `route` is a metric label, and one label value per task id turns a histogram
   *    into a memory leak (rules/observability.mdc, rule 9).
   * 2. Secrets — an unmatched path is frequently a mistyped or probed URL, and the product has
   *    paths whose *segment* is the credential (`/l/:token` for protected links). Logging the raw
   *    URL of an unmatched request would write those tokens into every aggregator.
   */
  it('reports an unmatched request as a constant, never as its URL', () => {
    expect(routeTemplateOf({ originalUrl: '/l/8f3c-secret-share-token' })).toBe(UNMATCHED_ROUTE);
    expect(routeTemplateOf({ originalUrl: '/l/8f3c-secret-share-token' })).not.toContain('secret');
  });

  it('reports an unmatched request even when the router matched a mount but no route', () => {
    expect(
      routeTemplateOf({ baseUrl: '/api/v1/tasks', originalUrl: '/api/v1/tasks/nope/nope' }),
    ).toBe(UNMATCHED_ROUTE);
  });
});
