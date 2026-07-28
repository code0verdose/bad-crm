import { PERMISSIONS } from '@bad-crm/shared/permissions';
import { type RequestHandler } from 'express';
import { describe, expect, it } from 'vitest';

import { createRouteRegistry } from '@/presentation/http/route-registry.factory.js';
import {
  authorizationFormOf,
  isGuardedRoute,
  isPublicRoute,
  isSelfServiceRoute,
  requiresAuthentication,
  requiresPermission,
  type GuardedRoute,
  type PublicRoute,
  type RouteDeclaration,
  type SelfServiceRoute,
} from '@/presentation/http/route-registry.types.js';
import { createTestApp } from '../../support/test-app.util.js';

const registry = (): readonly RouteDeclaration[] =>
  createRouteRegistry(createTestApp().container.http);

const keyOf = (route: RouteDeclaration): string => `${route.method.toUpperCase()} ${route.path}`;

const noop: RequestHandler = (_request, _response, next) => next();

const GUARDED: GuardedRoute = {
  method: 'get',
  path: '/api/v1/tasks',
  handlers: [noop],
  permission: 'task:read',
};

const PUBLIC: PublicRoute = {
  method: 'get',
  path: '/health',
  handlers: [noop],
  public: true,
  publicReason: 'liveness probe of the container manager, which runs before any session exists',
};

const SELF_SERVICE: SelfServiceRoute = {
  method: 'get',
  path: '/api/v1/auth/sessions',
  handlers: [noop],
  selfService: true,
  selfServiceReason:
    'reading one’s own sessions: the subject and the object are the same person, so no capability applies',
  ownershipCheckedIn: 'ListSessionsQuery',
};

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

/**
 * The third form of the union, and the one to watch.
 *
 * Every authenticated operation of EPIC-006 is a person acting on themselves — their own session,
 * their own password, their own list of devices. No key in
 * `packages/shared/src/permissions/permissions.catalog.ts` fits (the administrator's right over
 * *another* person's sessions is a different operation), and `public: true` would be a lie that
 * removes authentication from a route that requires it — and a lie every assertion above would pass
 * over. `docs/security/permission-model.md` §3.20 already recognises the category for a person's
 * own key pair; this is the same shape, made structural.
 *
 * The fixtures below are the positive control of the classifier: the registry itself declares no
 * self-service route until the first controller of EPIC-006 lands, so a test that only walked the
 * registry would assert nothing at all and would keep passing if `isSelfServiceRoute` were wired to
 * `false`.
 */
describe('the self-service form of a route declaration', () => {
  it('is a form of its own: neither public nor guarded', () => {
    expect(isSelfServiceRoute(SELF_SERVICE)).toBe(true);
    expect(isPublicRoute(SELF_SERVICE)).toBe(false);
    expect(isGuardedRoute(SELF_SERVICE)).toBe(false);
  });

  it('leaves the other two forms classified as before', () => {
    expect(isSelfServiceRoute(GUARDED)).toBe(false);
    expect(isSelfServiceRoute(PUBLIC)).toBe(false);
    expect(isGuardedRoute(GUARDED)).toBe(true);
    expect(isPublicRoute(PUBLIC)).toBe(true);
  });

  it.each([
    [GUARDED, 'permission'],
    [PUBLIC, 'public'],
    [SELF_SERVICE, 'self-service'],
  ] as const)('names the form the specification has to agree with', (route, form) => {
    expect(authorizationFormOf(route)).toBe(form);
  });

  /**
   * The property the form exists for, and the reason it is not `public: true` with a nicer comment:
   * the authentication guard stays mounted, only the permission guard is skipped. `EPIC-006` mounts
   * both by iterating the registry, so these two predicates are what decides it rather than a
   * reviewer remembering the distinction.
   */
  it('keeps the authentication guard and drops only the permission guard', () => {
    expect(requiresAuthentication(SELF_SERVICE)).toBe(true);
    expect(requiresPermission(SELF_SERVICE)).toBe(false);
  });

  it('keeps a guarded route behind both guards, and a public route behind neither', () => {
    expect([requiresAuthentication(GUARDED), requiresPermission(GUARDED)]).toEqual([true, true]);
    expect([requiresAuthentication(PUBLIC), requiresPermission(PUBLIC)]).toEqual([false, false]);
  });

  /**
   * `ownershipCheckedIn` is required where `aclCheckedIn` is optional, and the difference is
   * deliberate: this is the form somebody would reach for to get an endpoint past review without a
   * permission, so it has to name the place that verifies the caller owns the thing. A missing name
   * is a compile error; an empty one is this test.
   */
  it('refuses an empty ownership site or an empty reason in the registry', () => {
    const thin = registry()
      .filter(isSelfServiceRoute)
      .filter(
        (route) =>
          route.ownershipCheckedIn.trim() === '' || route.selfServiceReason.trim().length <= 20,
      )
      .map(keyOf);

    expect(
      thin,
      `self-service without a real ownership check or reason: ${thin.join(', ')}`,
    ).toEqual([]);
  });
});
