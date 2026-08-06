import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type Server } from 'node:http';

import { SharedPermissions } from '@bad-crm/shared';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { isGuardedRoute, type RouteDeclaration } from '@/presentation/http/route-registry.types.js';
import { createRouteRegistry } from '@/presentation/http/route-registry.factory.js';

import { createAuthApp, type AuthApp } from '../support/auth-app.util.js';
import { createTestApp } from '../support/test-app.util.js';

/**
 * What each system role actually gets from each guarded endpoint — as a file a reviewer reads.
 *
 * The permission model has two representations already: the catalogue (which keys exist) and the
 * role matrix (which role holds which key). Neither answers the question a reviewer actually has in
 * front of a diff — **«did this change what anybody can do»** — because the answer depends on the
 * route declaration, the guard, the use-case and the policy together.
 *
 * So it is measured rather than reasoned about: every guarded route is called over HTTP by an actor
 * carrying exactly the permissions of each system role, and the outcome is written down. A change of
 * access then shows up as a diff in a committed file, with the direction spelled out — widening is
 * not the same kind of event as narrowing, and «404 became 403» is not cosmetic at all.
 *
 * **What this cannot see yet:** the resource layer. No route in the product is resource-scoped
 * (`requiredLevel` is `null` for every key in the registry today), so every cell here is the
 * capability decision. When the first ACL-bearing domain lands (EPIC-014), the matrix gains a second
 * dimension and the fixtures gain a resource — the shape of this file is chosen to make that an
 * addition rather than a rewrite.
 */

const SNAPSHOT = fileURLToPath(new URL('./__snapshots__/permission-matrix.json', import.meta.url));

const IVAN = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a51';
const ROLE_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a52';
const PASSWORD = 'correct-horse-battery';
const IDEMPOTENCY_KEY = 'd'.repeat(32);
const REASON = 'matrix fixture reason, long enough';

/**
 * How a request is made for one route. Registry-driven, so a new route without one fails below.
 *
 * The target is a listening server rather than the Express app: `request(app)` binds a fresh
 * ephemeral port per call, and this file makes hundreds of them in one run — enough for the operating
 * system to recycle a port under a socket that has not finished closing, which surfaces as
 * «Parse Error: Expected HTTP/» on an unrelated cell. One server per cell, closed when the cell is
 * done, removes the recycling.
 */
type Target = Parameters<typeof request>[0];
type Call = (target: Target, token: string) => request.Test;

const CALLS: Readonly<Record<string, Call>> = {
  'GET /api/v1/roles': (target, token) =>
    request(target).get('/api/v1/roles').set('Authorization', `Bearer ${token}`),
  'POST /api/v1/roles': (app, token) =>
    request(app)
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ key: 'matrix_role', name: 'Matrix', permissions: [] }),
  'PATCH /api/v1/roles/:roleId': (app, token) =>
    request(app)
      .patch(`/api/v1/roles/${ROLE_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Matrix', permissions: [] }),
  'DELETE /api/v1/roles/:roleId': (app, token) =>
    request(app).delete(`/api/v1/roles/${ROLE_ID}`).set('Authorization', `Bearer ${token}`),
  'POST /api/v1/users/:userId/roles': (app, token) =>
    request(app)
      .post(`/api/v1/users/${IVAN}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ roleId: ROLE_ID }),
  'DELETE /api/v1/users/:userId/roles/:roleId': (app, token) =>
    request(app)
      .delete(`/api/v1/users/${IVAN}/roles/${ROLE_ID}`)
      .set('Authorization', `Bearer ${token}`),
  'PUT /api/v1/users/:userId/permission-overrides/:permission': (app, token) =>
    request(app)
      .put(`/api/v1/users/${IVAN}/permission-overrides/task%3Aread`)
      .set('Authorization', `Bearer ${token}`)
      .send({ effect: 'ALLOW', reason: REASON }),
  'DELETE /api/v1/users/:userId/permission-overrides/:permission': (app, token) =>
    request(app)
      .delete(`/api/v1/users/${IVAN}/permission-overrides/task%3Aread`)
      .set('Authorization', `Bearer ${token}`),
};

const guardedRoutes = (): RouteDeclaration[] =>
  createRouteRegistry(createTestApp().container.http).filter((route) => isGuardedRoute(route));

const keyOf = (route: RouteDeclaration): string => `${route.method.toUpperCase()} ${route.path}`;

/** One cell: `allow`, or `deny:<reason>` — the reason is the point, not the refusal. */
const outcomeOf = (status: number, body: unknown): string => {
  if (status < 300) return 'allow';

  const reason = (body as { reason?: string; code?: string } | undefined)?.reason;

  return `deny:${reason ?? (body as { code?: string } | undefined)?.code ?? String(status)}`;
};

const signIn = async (target: Target): Promise<string> => {
  await request(target)
    .post('/api/v1/auth/register')
    .set('Idempotency-Key', IDEMPOTENCY_KEY)
    .send({
      organization: { name: 'Bad Company', slug: 'bad-company' },
      owner: { email: 'ada@example.com', password: PASSWORD },
    })
    .expect(201);

  const response = await request(target)
    .post('/api/v1/auth/login')
    .send({ email: 'ada@example.com', password: PASSWORD })
    .expect(200);

  return (response.body as { accessToken: string }).accessToken;
};

/**
 * One listening socket for the whole measurement, in front of a per-cell application.
 *
 * Every cell needs its own application — the capabilities of the caller are what is being varied,
 * and a shared one would also carry the writes of the previous cell. But a port per cell means
 * dozens of sockets opened and closed in a few seconds, and the operating system hands a recycled
 * port to a client while the previous socket is still draining: the response then arrives at a
 * parser expecting a fresh one, which reads as «Parse Error: Expected HTTP/» on whichever cell was
 * unlucky. One port for the run removes the recycling; the application behind it is still fresh.
 */
const hostFor = (current: () => AuthApp): Server =>
  express()
    .use((request_, response_, next) => {
      current().app(request_, response_, next);
    })
    .listen(0);

/** The matrix, measured: role → route → outcome. */
const measure = async (): Promise<Record<string, Record<string, string>>> => {
  const matrix: Record<string, Record<string, string>> = {};
  let cell: AuthApp | undefined;
  const host = hostFor(() => {
    if (cell === undefined) throw new Error('a request reached the host before a cell was mounted');

    return cell;
  });

  try {
    for (const role of SharedPermissions.SYSTEM_ROLE_KEYS) {
      const row: Record<string, string> = {};

      for (const route of guardedRoutes()) {
        const call = CALLS[keyOf(route)];

        if (call === undefined) throw new Error(`no call defined for ${keyOf(route)}`);

        cell = createAuthApp({
          capabilities: {
            // The owner's actor carries an empty set on purpose — ownership short-circuits the
            // capability layers rather than enumerating 331 keys.
            isOwner: role === 'owner',
            granted: role === 'owner' ? [] : [...SharedPermissions.SYSTEM_ROLE_PERMISSIONS[role]],
            denied: [],
            roleKeys: [],
            permissionsVersion: 1,
          },
          capabilitiesByUser: {
            [IVAN]: {
              isOwner: false,
              granted: [],
              denied: [],
              roleKeys: [],
              permissionsVersion: 1,
            },
          },
        });

        const token = await signIn(host);
        const response = await call(host, token);

        row[keyOf(route)] = outcomeOf(response.status, response.body);
      }

      matrix[role] = row;
    }
  } finally {
    host.close();
  }

  return matrix;
};

interface Snapshot {
  readonly catalogSize: number;
  readonly matrix: Record<string, Record<string, string>>;
}

const readSnapshot = (): Snapshot => JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot;

/**
 * What a reviewer is shown when a cell moved — direction first, because the two directions are not
 * the same event.
 *
 * A refusal that became an allowance is a widening of access; a `resource_not_found` that became a
 * `permission_not_granted` tells a caller that an object they may not see exists, which is the
 * oracle invariant 2 exists to close. Neither reads as important in a raw JSON diff, which is why
 * this prints them as sentences.
 */
const describeChange = (role: string, route: string, before: string, after: string): string => {
  const widened = before.startsWith('deny') && after === 'allow';
  const disclosed = before === 'deny:resource_not_found' && after.startsWith('deny:permission');
  const marker = widened
    ? '⚠ расширение прав'
    : disclosed
      ? '⚠ раскрытие существования'
      : 'изменение';

  return `${marker}: ${role} ${route} ${before} → ${after}`;
};

describe('the permission matrix of the system roles', () => {
  it('CONTROL: every guarded route is exercised', () => {
    // Against a registry whose routes have no call defined, `measure` would throw; against an empty
    // registry it would silently produce empty rows and this file would compare nothing.
    const routes = guardedRoutes().map((route) => keyOf(route));

    expect(routes.length).toBeGreaterThan(0);
    expect(routes.filter((route) => CALLS[route] === undefined)).toEqual([]);
  });

  it('matches the committed snapshot, cell by cell', async () => {
    const measured = await measure();
    const snapshot = readSnapshot();
    const changes: string[] = [];

    for (const [role, row] of Object.entries(measured)) {
      for (const [route, outcome] of Object.entries(row)) {
        const before = snapshot.matrix[role]?.[route];

        if (before === undefined) changes.push(`новая ячейка: ${role} ${route} → ${outcome}`);
        else if (before !== outcome) changes.push(describeChange(role, route, before, outcome));
      }
    }

    for (const [role, row] of Object.entries(snapshot.matrix)) {
      for (const route of Object.keys(row)) {
        if (measured[role]?.[route] === undefined) {
          changes.push(`ячейка исчезла: ${role} ${route}`);
        }
      }
    }

    if (changes.length > 0 && process.env['UPDATE_PERMISSION_MATRIX'] === '1') {
      writeFileSync(
        SNAPSHOT,
        `${JSON.stringify({ catalogSize: SharedPermissions.PERMISSIONS.length, matrix: measured }, null, 2)}\n`,
      );
    }

    expect(
      changes,
      'права изменились — проверь направление и обнови снапшот осознанно:\n' +
        'UPDATE_PERMISSION_MATRIX=1 pnpm --filter @bad-crm/server test permission-matrix',
    ).toEqual([]);
  }, 60_000);

  /**
   * The size of the catalogue travels with the matrix so that a key added without a matrix change is
   * still a visible diff: a permission nobody grants and no route checks is either unfinished work
   * or a key that should have been deprecated.
   */
  it('was taken against the catalogue as it is today', () => {
    expect(readSnapshot().catalogSize).toBe(SharedPermissions.PERMISSIONS.length);
  });
});
