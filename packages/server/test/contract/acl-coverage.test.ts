import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  isGuardedRoute,
  isSelfServiceRoute,
  type RouteDeclaration,
} from '@/presentation/http/route-registry.types.js';

import { createRouteRegistry } from '@/presentation/http/route-registry.factory.js';

import { createTestApp } from '../support/test-app.util.js';

/**
 * A route that addresses one object names the place the object-level check happens — and that place
 * exists.
 *
 * The capability guard is a fail-fast filter: it answers «may this caller do this anywhere», which
 * is not the question a route with an id in the path is asking. The authoritative check belongs to
 * the use-case, because it is the only layer that also knows whether the object is in this
 * organization at all — and therefore the only one that can answer **404 rather than 403** for
 * somebody else's id (invariant 2 of CLAUDE.md).
 *
 * `aclCheckedIn` is how a declaration states that. This file is what keeps it from being decoration:
 * a route with a parameter and no name fails, a name that resolves to nothing fails too — which is
 * the failure mode a string field invites after the class it referred to is renamed — and, since
 * 2026-08-28, a named class that authorises nothing fails as well.
 *
 * **Why that last one is scoped to parameterised routes.** `rules/permissions.mdc` promised it
 * unscoped, and unscoped it cannot be written: `ListTeamsQuery` and `GetOrgChartQuery` carry an
 * `aclCheckedIn` and contain no authorisation call at all, correctly — a list is filtered in SQL
 * under `withTenant`, and RLS *is* the check there (invariant 1, and «списочные endpoint'ы
 * фильтруют в SQL» of invariant 2). A gate that demanded `assertAllowed` from them would be red on
 * two correct classes, and a gate people have to argue with is a gate people delete. A route with
 * an id in the path has no such alternative: something has to decide whether *this* object is
 * reachable, and say 404 when it is not.
 */

const SOURCE_ROOT = fileURLToPath(new URL('../../src', import.meta.url));

const PARAMETERISED = /:[A-Za-z]/;

/** Every `export class X` / `export const X =` under `src/`, as a set of names. */
const exportedNames = (directory: string): Set<string> => {
  const names = new Set<string>();

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) {
      for (const name of exportedNames(path)) names.add(name);
      continue;
    }

    if (!entry.name.endsWith('.ts')) continue;

    for (const [, name] of readFileSync(path, 'utf8').matchAll(
      /export (?:abstract )?class (\w+)|export const (\w+)\s*[=:]/g,
    )) {
      if (name !== undefined) names.add(name);
    }
  }

  return names;
};

/** `AssignRoleUseCase.revoke` names a method of a class; the class is what has to exist. */
const classOf = (reference: string): string => reference.split('.')[0] ?? reference;

/**
 * What counts as authorising, spelled as the four shapes this codebase actually uses.
 *
 * `denyAccess` is in the list because refusing is the same decision as allowing: a use-case that
 * only ever denies (`tenant_mismatch` → 404) has made the call this field is about.
 */
const AUTHORISES = /assertAllowed|authorizeCapability|authorizeWith|authorizeResource|denyAccess/;

/** The source of a class named in a declaration, found once and cached for the whole file. */
const sources = new Map<string, string | undefined>();

const sourceOf = (name: string): string | undefined => {
  if (sources.has(name)) return sources.get(name);

  const found = findSource(SOURCE_ROOT, new RegExp(`export (?:abstract )?class ${name}\\b`));

  sources.set(name, found);

  return found;
};

const findSource = (directory: string, pattern: RegExp): string | undefined => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) {
      const nested = findSource(path, pattern);

      if (nested !== undefined) return nested;

      continue;
    }

    if (!entry.name.endsWith('.ts')) continue;

    const body = readFileSync(path, 'utf8');

    if (pattern.test(body)) return body;
  }

  return undefined;
};

const declarations: readonly RouteDeclaration[] = createRouteRegistry(
  createTestApp().container.http,
);

describe('routes that address one object', () => {
  it('CONTROL: the registry has parameterised routes at all', () => {
    // Against an empty list every assertion below passes, and this file would report that a registry
    // with no such route is fully covered.
    expect(declarations.filter((route) => PARAMETERISED.test(route.path)).length).toBeGreaterThan(
      0,
    );
  });

  it('name the use-case that checks the object, on every guarded one', () => {
    const unnamed = declarations
      .filter((route) => isGuardedRoute(route) && PARAMETERISED.test(route.path))
      .filter((route) => (isGuardedRoute(route) ? route.aclCheckedIn === undefined : false))
      .map((route) => `${route.method.toUpperCase()} ${route.path}`);

    expect(unnamed).toEqual([]);
  });

  it('name the ownership check on every self-service one', () => {
    // The type already makes `ownershipCheckedIn` mandatory there; this is the runtime half, and it
    // catches the value being present and empty.
    const unnamed = declarations
      .filter((route) => isSelfServiceRoute(route))
      .filter((route) =>
        isSelfServiceRoute(route) ? route.ownershipCheckedIn.trim() === '' : false,
      )
      .map((route) => `${route.method.toUpperCase()} ${route.path}`);

    expect(unnamed).toEqual([]);
  });

  /**
   * The half `rules/permissions.mdc` claimed and this file did not have until 2026-08-28.
   *
   * Naming a class proves a string resolves; it does not prove the class does the thing the name
   * promises. A use-case that was refactored until its authorisation call disappeared keeps its
   * declaration, keeps its route, and keeps passing every check in this file — while the object is
   * reachable by anybody the capability guard let through, from any organization.
   *
   * The evidence is deliberately coarse: the presence of a call in the source of the named class,
   * not a proof that it runs on every path. A finer check would need the call graph, and the cheap
   * version already catches the regression that actually happens — the last authorisation call
   * being removed.
   */
  it('name a class that authorises something, on every parameterised route', () => {
    const known = exportedNames(SOURCE_ROOT);
    const silent = declarations
      .filter((route) => isGuardedRoute(route) && PARAMETERISED.test(route.path))
      .flatMap((route) => {
        const reference = isGuardedRoute(route) ? route.aclCheckedIn : undefined;

        if (reference === undefined || !known.has(classOf(reference))) return [];

        return sourceOf(classOf(reference)) === undefined ||
          AUTHORISES.test(sourceOf(classOf(reference)) ?? '')
          ? []
          : [`${route.method.toUpperCase()} ${route.path} → ${reference}`];
      });

    expect(
      silent,
      'the class named in `aclCheckedIn` contains no authorisation call — invariant 2 puts the authoritative decision in the use-case, not in the middleware',
    ).toEqual([]);
  });

  it('name something that exists in the source', () => {
    const known = exportedNames(SOURCE_ROOT);
    const dangling = declarations
      .flatMap((route) => {
        if (isGuardedRoute(route) && route.aclCheckedIn !== undefined) return [route.aclCheckedIn];
        if (isSelfServiceRoute(route)) return [route.ownershipCheckedIn];

        return [];
      })
      .filter((reference) => !known.has(classOf(reference)));

    expect(dangling).toEqual([]);
  });
});
