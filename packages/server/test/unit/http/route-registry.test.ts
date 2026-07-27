import { PERMISSIONS } from '@bad-crm/shared/permissions';
import { describe, expect, it } from 'vitest';

import { createRouteRegistry } from '@/presentation/http/route-registry.factory.js';
import {
  isGuardedRoute,
  isPublicRoute,
  type RouteDeclaration,
} from '@/presentation/http/route-registry.types.js';
import { createTestApp } from '../../support/test-app.util.js';

const registry = (): readonly RouteDeclaration[] =>
  createRouteRegistry(createTestApp().container.http);

const keyOf = (route: RouteDeclaration): string => `${route.method.toUpperCase()} ${route.path}`;

describe('the route registry', () => {
  it('is not empty, so every assertion below means something', () => {
    expect(registry().length).toBeGreaterThan(0);
  });

  it('declares each path × method once', () => {
    const keys = registry().map(keyOf);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('mounts at least one handler per route', () => {
    for (const route of registry()) {
      expect(route.handlers.length, keyOf(route)).toBeGreaterThan(0);
    }
  });

  /**
   * Invariant 2 of CLAUDE.md, expressed as a data structure: a route is either gated by a key from
   * the closed catalog, or it is public *and says why*. There is no third option — `RouteDeclaration`
   * is a union, so a route with neither does not compile. What these tests add is the part the type
   * cannot express: that the reason is a real sentence rather than an empty string put there to
   * satisfy the compiler, and that the key is one the catalog actually contains.
   */
  describe('every route states its authorization', () => {
    it('has public routes, so the assertion about their reasons is not vacuous', () => {
      expect(registry().filter(isPublicRoute).length).toBeGreaterThan(0);
    });

    it('gives every public route a reason a reviewer can weigh', () => {
      const vague = registry()
        .filter(isPublicRoute)
        .filter((route) => route.publicReason.trim().length <= 20)
        .map(keyOf);

      expect(vague, `public without a real reason: ${vague.join(', ')}`).toEqual([]);
    });

    /**
     * Vacuous today — every route in the registry is public until EPIC-006 introduces sessions —
     * and deliberately written now: the assertion has to exist before the first gated route, not
     * after somebody notices it is missing.
     */
    it('gates nothing on a key outside the shared catalog', () => {
      const unknown = registry()
        .filter(isGuardedRoute)
        .filter((route) => !PERMISSIONS.includes(route.permission))
        .map(keyOf);

      expect(unknown, `not in permissions.catalog.ts: ${unknown.join(', ')}`).toEqual([]);
    });

    /**
     * `rules/permissions.mdc` §3: the capability is a fail-fast filter, and the authoritative
     * decision for a specific resource — including the choice of 404 over 403 for another
     * organization — lives in a use-case that has to be named here.
     */
    it('names the use-case performing the ACL check on every route with an id parameter', () => {
      const missing = registry()
        .filter(isGuardedRoute)
        .filter((route) => route.path.includes(':'))
        .filter((route) => route.aclCheckedIn === undefined)
        .map(keyOf);

      expect(missing, `no aclCheckedIn: ${missing.join(', ')}`).toEqual([]);
    });
  });
});
