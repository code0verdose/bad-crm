import { describe, expect, it } from 'vitest';

import { createRouteRegistry } from '../../src/presentation/http/route-registry.factory.js';
import {
  authorizationFormOf,
  isPublicRoute,
  type AuthorizationForm,
} from '../../src/presentation/http/route-registry.types.js';
import { createTestApp } from '../support/test-app.util.js';
import { collectRoutes, normalizePath, routeKey } from './collect-routes.util.js';
import {
  PLANNED_MARKER,
  plannedRouteKeys,
  readOpenApiDocument,
  serverBasePath,
  specAuthorizationForm,
  specOperationEntries,
  specOperations,
} from './openapi-document.util.js';
import {
  isAllowedServiceRoute,
  SERVICE_ROUTE_ALLOW_LIST,
} from './service-route-allow-list.constant.js';

/**
 * The application is built with no database, no Redis and no network: `createTestApp` wires the
 * real container out of in-process adapters. That is a requirement of this suite and not an
 * accident — a contract test that needs an environment is a contract test that gets skipped.
 */
const routes = (): ReturnType<typeof collectRoutes> => collectRoutes(createTestApp().app);
const operations = (): ReturnType<typeof specOperations> => specOperations(readOpenApiDocument());

const keys = (collected: ReturnType<typeof collectRoutes>): string[] => collected.map(routeKey);

/**
 * Operations published ahead of their implementation, each naming the story that implements it.
 *
 * They are excluded from the specification → router direction and from nothing else: the router →
 * specification direction still refuses an undocumented route, and `planned-operations.test.ts`
 * checks that a marked operation is genuinely unimplemented and that the story it names exists.
 */
const planned = (): Set<string> => plannedRouteKeys(readOpenApiDocument());

const implemented = (): ReturnType<typeof specOperations> => {
  const markers = planned();

  return operations().filter((operation) => !markers.has(routeKey(operation)));
};

describe('the router and the specification agree', () => {
  it('has routes and operations, so neither direction below is vacuous', () => {
    expect(routes().length).toBeGreaterThan(0);
    expect(operations().length).toBeGreaterThan(0);
  });

  /**
   * Direction 1 — router → specification. An endpoint that exists and is undocumented is an
   * endpoint no external integrator knows about and no reviewer ever discussed.
   */
  it('describes every registered route, except the service allow-list', () => {
    const documented = new Set(keys(operations()));
    const undocumented = routes()
      .filter((route) => !isAllowedServiceRoute(route.path))
      .filter((route) => !documented.has(routeKey(route)))
      .map(routeKey);

    expect(
      undocumented,
      `route not described in docs/api/openapi.yaml: ${undocumented.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * Direction 2 — specification → router. A published operation with no implementation is a 404 a
   * client only discovers at runtime, after writing code against the contract.
   */
  it('implements every operation the specification publishes', () => {
    const registered = new Set(keys(routes()));
    const unimplemented = implemented()
      .filter((operation) => !registered.has(routeKey(operation)))
      .map(routeKey);

    expect(
      unimplemented,
      `operation not implemented: ${unimplemented.join(', ')} — add the route, or mark the operation \`${PLANNED_MARKER}: STORY-XXX-YY\` if it is published ahead of its implementation`,
    ).toEqual([]);
  });

  /**
   * Path *and* method. Comparing paths alone lets `PATCH /things/{id}` in the document pass while
   * only `PUT` is registered — the caller gets a 404 from an operation the contract promised.
   */
  it('compares path × method, not path alone', () => {
    const documentedPaths = new Set(implemented().map((operation) => operation.path));
    const registeredPaths = new Set(
      routes()
        .filter((route) => !isAllowedServiceRoute(route.path))
        .map((route) => route.path),
    );

    for (const key of keys(operations())) {
      expect(key).toMatch(/^[A-Z]+ \//);
    }

    expect([...documentedPaths].sort()).toEqual([...registeredPaths].sort());
  });

  it('reads the version prefix out of the document instead of hard-coding it', () => {
    expect(serverBasePath(readOpenApiDocument())).toBe('/api/v1');
  });
});

describe('parameter names do not have to match, shapes do', () => {
  it.each([
    ['/things/:thingId', '/things/{param}'],
    ['/things/{taskId}', '/things/{param}'],
    ['/things/:a/parts/:b', '/things/{param}/parts/{param}'],
    ['/health', '/health'],
  ])('normalizes %s to %s', (path, expected) => {
    expect(normalizePath(path)).toBe(expected);
  });
});

/**
 * The allow-list is the one place this test can be weakened, so it is itself under test: an empty
 * list would make the "except the service allow-list" clause meaningless, and a wildcard entry
 * would exempt everything anybody later mounts beneath it.
 */
describe('the service allow-list is explicit', () => {
  it('is not empty', () => {
    expect(SERVICE_ROUTE_ALLOW_LIST.length).toBeGreaterThan(0);
  });

  it.each(SERVICE_ROUTE_ALLOW_LIST)('states why $path is exempt', ({ reason }) => {
    expect(reason.trim().length).toBeGreaterThan(20);
  });

  it.each(SERVICE_ROUTE_ALLOW_LIST)('exempts $path as an exact path, with no mask', ({ path }) => {
    expect(path).not.toMatch(/[*{}:]/);
  });

  it('matches nothing beyond the paths it lists', () => {
    expect(isAllowedServiceRoute('/health')).toBe(true);
    expect(isAllowedServiceRoute('/health/secret')).toBe(false);
    expect(isAllowedServiceRoute('/api/v1/meta')).toBe(false);
  });

  it('exempts only paths that are actually served or reserved for a named epic', () => {
    const served = new Set(routes().map((route) => route.path));
    const unserved = SERVICE_ROUTE_ALLOW_LIST.filter((entry) => !served.has(entry.path));

    // `/metrics` and `/socket.io` are not mounted yet; each names the epic that will mount it.
    for (const entry of unserved) {
      expect(entry.reason, entry.path).toMatch(/EPIC-\d+/);
    }
  });
});

/**
 * Invariant 2 of CLAUDE.md, as a build failure rather than as a review habit: no route exists
 * without a declaration that says which permission gates it, or why it is public.
 *
 * The registry is also compared against the *finished* application, not trusted on its own — a
 * route mounted by anything other than `api.routes.ts` shows up here as a route with no entry.
 */
describe('every route is declared in the registry', () => {
  const declared = (): string[] =>
    createRouteRegistry(createTestApp().container.http).map(
      (route) => `${route.method.toUpperCase()} ${normalizePath(route.path)}`,
    );

  it('mounts exactly what the registry declares, and nothing else', () => {
    expect(keys(routes()).sort()).toEqual([...declared()].sort());
  });

  it('leaves no registry entry unmounted', () => {
    const mounted = new Set(keys(routes()));
    const unmounted = declared().filter((key) => !mounted.has(key));

    expect(unmounted, `declared but not mounted: ${unmounted.join(', ')}`).toEqual([]);
  });

  it('gives every product operation a permission or a stated reason for being public', () => {
    const registry = createRouteRegistry(createTestApp().container.http);
    const undeclared = registry
      .filter((route) => (isPublicRoute(route) ? route.publicReason.trim() === '' : false))
      .map((route) => `${route.method.toUpperCase()} ${route.path}`);

    expect(registry.length).toBeGreaterThan(0);
    expect(undeclared, `public with an empty reason: ${undeclared.join(', ')}`).toEqual([]);
  });
});

/**
 * The two halves of "who may call this" have to say the same thing.
 *
 * `docs/api/openapi.yaml` marks every operation `x-permission`, `x-public-reason` or
 * `x-self-service-reason`, and `route-registry.types.ts` declares the same three forms. Nothing so
 * far compared them, and the drift that matters is silent in both directions: an operation
 * published as authenticated (`x-self-service-reason`) served by a route declared `public: true`
 * loses its authentication guard while the contract still promises one, and a route tightened to a
 * permission while the document still says `x-public-reason` publishes an endpoint every generated
 * client will call without credentials.
 *
 * Planned operations are excluded from the specification → registry direction only: they have no
 * route yet by construction (`planned-operations.test.ts` proves that separately).
 */
describe('the registry and the specification agree on who may call each route', () => {
  const registryForms = (): Map<string, AuthorizationForm> =>
    new Map(
      createRouteRegistry(createTestApp().container.http).map((route) => [
        `${route.method.toUpperCase()} ${normalizePath(route.path)}`,
        authorizationFormOf(route),
      ]),
    );

  const specForms = (): Map<string, AuthorizationForm | undefined> =>
    new Map(
      specOperationEntries(readOpenApiDocument()).map((entry) => [
        entry.routeKey,
        specAuthorizationForm(entry.operation),
      ]),
    );

  /** Both assertions below walk an intersection; an empty one would make both of them silent. */
  it('has routes that are also published operations, so neither direction is vacuous', () => {
    const documented = specForms();
    const shared = [...registryForms().keys()].filter((key) => documented.has(key));

    expect(shared.length).toBeGreaterThan(0);
  });

  it('declares in the registry the form the document publishes', () => {
    const documented = specForms();
    const disagreeing = [...registryForms().entries()]
      .filter(([key]) => documented.has(key))
      .filter(([key, form]) => documented.get(key) !== form)
      .map(
        ([key, form]) =>
          `${key}: registry says ${form}, specification says ${documented.get(key) ?? 'nothing'}`,
      );

    expect(disagreeing, disagreeing.join('; ')).toEqual([]);
  });

  it('publishes in the document the form the registry declares', () => {
    const declared = registryForms();
    const disagreeing = [...specForms().entries()]
      .filter(([key]) => declared.has(key))
      .filter(([key, form]) => declared.get(key) !== form)
      .map(
        ([key, form]) =>
          `${key}: specification says ${form ?? 'nothing'}, registry says ${declared.get(key) ?? 'nothing'}`,
      );

    expect(disagreeing, disagreeing.join('; ')).toEqual([]);
  });
});
