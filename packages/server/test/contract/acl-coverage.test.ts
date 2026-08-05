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
 * a route with a parameter and no name fails, and a name that resolves to nothing fails too — which
 * is the failure mode a string field invites after the class it referred to is renamed.
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

const declarations: readonly RouteDeclaration[] = createRouteRegistry(
  createTestApp().container.http,
);

describe('routes that address one object', () => {
  it('CONTROL: the registry has parameterised routes at all', () => {
    // Against an empty list every assertion below passes, and this file would report that a registry
    // with no such route is fully covered.
    expect(declarations.filter((route) => PARAMETERISED.test(route.path)).length).toBeGreaterThan(0);
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
      .filter((route) => (isSelfServiceRoute(route) ? route.ownershipCheckedIn.trim() === '' : false))
      .map((route) => `${route.method.toUpperCase()} ${route.path}`);

    expect(unnamed).toEqual([]);
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
