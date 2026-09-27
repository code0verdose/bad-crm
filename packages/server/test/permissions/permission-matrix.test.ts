import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type Server } from 'node:http';

import { SharedPermissions } from '@bad-crm/shared';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { isGuardedRoute, type RouteDeclaration } from '@/presentation/http/route-registry.types.js';
import { createRouteRegistry } from '@/presentation/http/route-registry.factory.js';

import { createAuthApp, type AuthApp, type AuthAppOptions } from '../support/auth-app.util.js';
import { ORGANIZATION_ID } from '../support/identity-doubles.util.js';
import { FakeProjectStore } from '../support/project-doubles.util.js';
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
 * **The second dimension — the resource — arrived with `GET /projects/:projectId` (2026-09-06).**
 * Until then every cell was the capability decision alone: `organization:manage_security_policy`
 * carried `MANAGER` on three routes, but no routed key with a level had a resource reader on its
 * route, so nothing read the level. `project:read` is the first that does — `GetProjectDetailQuery`
 * resolves the ACL chain of the project before the row is read — and for such a route one cell per
 * role is not an answer: the same role gets `allow` on a `PUBLIC_ORG` project and
 * `deny:resource_not_found` on a `PRIVATE` one it is not on. So a route may name **fixtures**
 * (`FIXTURES` below), and it is measured once per fixture, with the fixture in the cell key. The
 * snapshot keeps its shape — `role → "METHOD /path [fixture]" → outcome` — which is what made this an
 * addition rather than a rewrite.
 *
 * Read the two project cells together. Every system role holds `project:read`, so on the public
 * fixture every role but one is `allow`; on the private one the same roles become
 * `deny:resource_not_found` — not `permission_*`, because the contour is closed and «not yours» must
 * read as «not there» (invariant 2). The one row that stays `allow` on both is the owner, who is
 * `MANAGER` on the root without a walk (rule 9 of `rules/permissions.mdc`); the one row that is
 * refused on both is `guest`, whose implicit level is `NONE` on every object (§5, last row) — the
 * key alone opens nothing for a guest. A role without the key would be `deny:permission_not_granted`
 * on both fixtures, because the capability is decided before the fixture gets a say; no system role
 * is in that position today, and `project-endpoints.test.ts` holds that cell instead.
 */

const SNAPSHOT = fileURLToPath(new URL('./__snapshots__/permission-matrix.json', import.meta.url));

const IVAN = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a51';
const ROLE_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a52';
const INVITATION_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a53';
const TEAM_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a54';
const PROJECT_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a55';
const ACL_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a56';
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
  'POST /api/v1/roles/preview-changes': (target, token) =>
    request(target)
      .post('/api/v1/roles/preview-changes')
      .set('Authorization', `Bearer ${token}`)
      .send({ changes: [{ roleId: ROLE_ID, permissions: [] }] }),
  'POST /api/v1/roles/apply-changes': (target, token) =>
    request(target)
      .post('/api/v1/roles/apply-changes')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ changes: [{ roleId: ROLE_ID, permissions: [] }] }),
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
  'GET /api/v1/users/:userId/permissions': (app, token) =>
    request(app).get(`/api/v1/users/${IVAN}/permissions`).set('Authorization', `Bearer ${token}`),
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
  'GET /api/v1/invitations': (target, token) =>
    request(target).get('/api/v1/invitations').set('Authorization', `Bearer ${token}`),
  'POST /api/v1/invitations': (app, token) =>
    request(app)
      .post('/api/v1/invitations')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ email: 'matrix@example.test', locale: 'en' }),
  'POST /api/v1/invitations/:invitationId/resend': (app, token) =>
    request(app)
      .post(`/api/v1/invitations/${INVITATION_ID}/resend`)
      .set('Authorization', `Bearer ${token}`),
  'DELETE /api/v1/invitations/:invitationId': (app, token) =>
    request(app)
      .delete(`/api/v1/invitations/${INVITATION_ID}`)
      .set('Authorization', `Bearer ${token}`),
  'GET /api/v1/teams': (target, token) =>
    request(target).get('/api/v1/teams').set('Authorization', `Bearer ${token}`),
  'POST /api/v1/teams': (app, token) =>
    request(app)
      .post('/api/v1/teams')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ name: 'Matrix', slug: 'matrix' }),
  'GET /api/v1/teams/:teamId': (target, token) =>
    request(target).get(`/api/v1/teams/${TEAM_ID}`).set('Authorization', `Bearer ${token}`),
  'PATCH /api/v1/teams/:teamId': (app, token) =>
    request(app)
      .patch(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Matrix', slug: 'matrix' }),
  'DELETE /api/v1/teams/:teamId': (app, token) =>
    request(app).delete(`/api/v1/teams/${TEAM_ID}`).set('Authorization', `Bearer ${token}`),
  'POST /api/v1/teams/:teamId/members': (app, token) =>
    request(app)
      .post(`/api/v1/teams/${TEAM_ID}/members`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ userId: IVAN }),
  'DELETE /api/v1/teams/:teamId/members/:userId': (app, token) =>
    request(app)
      .delete(`/api/v1/teams/${TEAM_ID}/members/${IVAN}`)
      .set('Authorization', `Bearer ${token}`),
  'POST /api/v1/projects': (app, token) =>
    request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ key: 'MTX', name: 'Matrix', leadId: IVAN, color: 'indigo' }),
  // One cell, like every capability-only route: which projects the answer holds is not a status
  // code, and `test/integration/db/project-list.test.ts` holds the list against `can()` per row.
  'GET /api/v1/projects': (app, token) =>
    request(app).get('/api/v1/projects').set('Authorization', `Bearer ${token}`),
  // The switcher (STORY-014-06): the list's capability and the list's visible set — one cell too.
  'GET /api/v1/projects/options': (app, token) =>
    request(app).get('/api/v1/projects/options').set('Authorization', `Bearer ${token}`),
  'GET /api/v1/projects/:projectId': (target, token) =>
    request(target).get(`/api/v1/projects/${PROJECT_ID}`).set('Authorization', `Bearer ${token}`),
  'PATCH /api/v1/projects/:projectId': (app, token) =>
    request(app)
      .patch(`/api/v1/projects/${PROJECT_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Matrix', leadId: IVAN, color: 'indigo' }),
  'DELETE /api/v1/projects/:projectId': (app, token) =>
    request(app).delete(`/api/v1/projects/${PROJECT_ID}`).set('Authorization', `Bearer ${token}`),
  'POST /api/v1/projects/:projectId/visibility': (app, token) =>
    request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/visibility`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Confirm-Dangerous', '1')
      .send({ visibility: 'PRIVATE' }),
  'GET /api/v1/projects/:projectId/visibility-impact': (target, token) =>
    request(target)
      .get(`/api/v1/projects/${PROJECT_ID}/visibility-impact?to=PRIVATE`)
      .set('Authorization', `Bearer ${token}`),
  'POST /api/v1/projects/:projectId/archive': (app, token) =>
    request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .send(),
  'GET /api/v1/projects/:projectId/members': (target, token) =>
    request(target)
      .get(`/api/v1/projects/${PROJECT_ID}/members`)
      .set('Authorization', `Bearer ${token}`),
  'POST /api/v1/projects/:projectId/members': (app, token) =>
    request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/members`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ userId: IVAN }),
  'PATCH /api/v1/projects/:projectId/members/:userId': (app, token) =>
    request(app)
      .patch(`/api/v1/projects/${PROJECT_ID}/members/${IVAN}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ projectRole: 'MEMBER' }),
  'DELETE /api/v1/projects/:projectId/members/:userId': (app, token) =>
    request(app)
      .delete(`/api/v1/projects/${PROJECT_ID}/members/${IVAN}`)
      .set('Authorization', `Bearer ${token}`),
  'GET /api/v1/acl': (target, token) =>
    request(target)
      .get(`/api/v1/acl?resourceType=PROJECT&resourceId=${PROJECT_ID}`)
      .set('Authorization', `Bearer ${token}`),
  'POST /api/v1/acl': (app, token) =>
    request(app)
      .post('/api/v1/acl')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({
        resourceType: 'PROJECT',
        resourceId: PROJECT_ID,
        subjectType: 'USER',
        subjectId: IVAN,
        accessLevel: 'VIEWER',
      }),
  'DELETE /api/v1/acl/:aclId': (app, token) =>
    request(app).delete(`/api/v1/acl/${ACL_ID}`).set('Authorization', `Bearer ${token}`),
  'GET /api/v1/employees': (target, token) =>
    request(target).get('/api/v1/employees').set('Authorization', `Bearer ${token}`),
  'GET /api/v1/employees/org-chart': (target, token) =>
    request(target).get('/api/v1/employees/org-chart').set('Authorization', `Bearer ${token}`),
  'GET /api/v1/organization/security-policy': (app, token) =>
    request(app)
      .get('/api/v1/organization/security-policy')
      .set('Authorization', `Bearer ${token}`),
  'PATCH /api/v1/organization/security-policy': (app, token) =>
    request(app)
      .patch('/api/v1/organization/security-policy')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ mfaRequiredForRoles: [], mfaGracePeriodDays: 0 }),
  'GET /api/v1/organization/mfa-coverage': (app, token) =>
    request(app).get('/api/v1/organization/mfa-coverage').set('Authorization', `Bearer ${token}`),
  'POST /api/v1/organization/transfer-ownership': (app, token) =>
    request(app)
      .post('/api/v1/organization/transfer-ownership')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ toUserId: IVAN }),
  'POST /api/v1/users/:userId/deactivate': (app, token) =>
    request(app)
      .post(`/api/v1/users/${IVAN}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ reason: 'left the company' }),
  'POST /api/v1/users/:userId/reactivate': (app, token) =>
    request(app)
      .post(`/api/v1/users/${IVAN}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({}),
  'POST /api/v1/users/:userId/reset-mfa': (app, token) =>
    request(app)
      .post(`/api/v1/users/${IVAN}/reset-mfa`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(),
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

/**
 * The resource each cell of a resource-scoped route is measured against.
 *
 * One entry per route whose use-case reads a level; a route absent here is measured once, on the
 * empty installation, as every capability-only route always was. Each fixture is a project the
 * caller is **not** on — membership would make the cell about the roster rather than about the
 * role, and the roster is `project-endpoints.test.ts`'s subject.
 */
interface ResourceFixture {
  readonly label: string;
  readonly options: () => Partial<AuthAppOptions>;
}

const projectFixture = (visibility: 'PUBLIC_ORG' | 'PRIVATE'): ResourceFixture => ({
  label: `${visibility} project, caller not on it`,
  options: () => {
    const projects = new FakeProjectStore();

    projects.seed({ projectId: PROJECT_ID, organizationId: ORGANIZATION_ID, visibility });
    // Ivan is on the project as an ordinary member, so the roster commands have a seat to change
    // and «the last lead» is not what the cell measures; the caller is still not on it.
    projects.addMember(PROJECT_ID, IVAN, 'MEMBER');
    projects.subjects.set(IVAN, { userId: IVAN, status: 'ACTIVE' });
    // One grant on the project, so the revocation cell measures the decision about it rather than
    // «no such grant»; the subject is Ivan, not the caller, for the same reason the roster is his.
    projects.seedGrant({
      id: ACL_ID,
      organizationId: ORGANIZATION_ID,
      resource: { type: 'PROJECT', id: PROJECT_ID },
      subject: { type: 'USER', id: IVAN },
      level: 'VIEWER',
      expiresAt: null,
      grantedById: null,
    });

    return { projects };
  },
});

/**
 * The write routes are measured on the same two fixtures as the read. The caller is a bystander on
 * both, so the resource half decides by visibility alone: `VIEWER` on `PUBLIC_ORG` — enough for
 * `project:read`, two to three levels short of `EDITOR`/`MANAGER` for every write, hence
 * `deny:insufficient_acl_level` inside the contour — and `NONE` on `PRIVATE`, which is
 * `deny:resource_not_found` for read and write alike (the closed contour on a mutation). The owner
 * clears the level on both; `guest` is `NONE` on both. `POST /projects` has no resource and is one
 * cell, as every capability-only route.
 */
const RESOURCE_ROUTES = [
  'GET /api/v1/projects/:projectId',
  'PATCH /api/v1/projects/:projectId',
  'DELETE /api/v1/projects/:projectId',
  'POST /api/v1/projects/:projectId/visibility',
  'GET /api/v1/projects/:projectId/visibility-impact',
  'POST /api/v1/projects/:projectId/archive',
  'GET /api/v1/projects/:projectId/members',
  'POST /api/v1/projects/:projectId/members',
  'PATCH /api/v1/projects/:projectId/members/:userId',
  'DELETE /api/v1/projects/:projectId/members/:userId',
  // The grant routes read the project's chain too: `VIEWER` for the list, `MANAGER` for a grant or
  // a revocation — and the project's closed contour, so `NONE` on `PRIVATE` is not-there here too.
  'GET /api/v1/acl',
  'POST /api/v1/acl',
  'DELETE /api/v1/acl/:aclId',
] as const;

/**
 * `POST /projects` has no resource — one cell, labelled plainly — but its use-case looks the lead
 * up as a subject before writing, so an empty installation would show every holder of
 * `project:create` as `deny:user_not_found`: the capability passed, the fixture failed. Ivan is
 * seeded as an active account so the cell measures the key and nothing else.
 */
const leadFixture: ResourceFixture = {
  label: '',
  options: () => {
    const projects = new FakeProjectStore();

    projects.subjects.set(IVAN, { userId: IVAN, status: 'ACTIVE' });

    return { projects };
  },
};

const FIXTURES: Readonly<Record<string, readonly ResourceFixture[]>> = {
  'POST /api/v1/projects': [leadFixture],
  ...Object.fromEntries(
    RESOURCE_ROUTES.map((route) => [
      route,
      [projectFixture('PUBLIC_ORG'), projectFixture('PRIVATE')],
    ]),
  ),
};

/** A capability-only route is one cell; a resource-scoped one is one cell per fixture. */
const cellsOf = (route: RouteDeclaration): readonly ResourceFixture[] =>
  FIXTURES[keyOf(route)] ?? [{ label: '', options: () => ({}) }];

const cellKey = (route: RouteDeclaration, fixture: ResourceFixture): string =>
  fixture.label === '' ? keyOf(route) : `${keyOf(route)} [${fixture.label}]`;

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

        for (const fixture of cellsOf(route)) {
          cell = createAuthApp({
            ...fixture.options(),
            capabilities: {
              // The owner's actor carries an empty set on purpose — ownership short-circuits the
              // capability layers rather than enumerating 331 keys.
              isOwner: role === 'owner',
              granted: role === 'owner' ? [] : [...SharedPermissions.SYSTEM_ROLE_PERMISSIONS[role]],
              denied: [],
              // The role's own key, because the resource dimension reads it: the implicit table
              // answers `NONE` for `guest` on every object (`implicit-level.policy.ts`), and a guest
              // measured with an empty `roleKeys` would be shown reading a public project it may
              // not. The capability cells do not read it and are unchanged by it.
              roleKeys: [role],
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

          row[cellKey(route, fixture)] = outcomeOf(response.status, response.body);
        }
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
  /** Every key flagged `dangerous`, sorted — see the case at the bottom of this file. */
  readonly dangerous: readonly string[];
  readonly matrix: Record<string, Record<string, string>>;
}

/** Every key the catalogue flags `dangerous`, sorted so the snapshot diff is stable. */
const dangerousKeys = (): string[] =>
  [...SharedPermissions.PERMISSIONS]
    .filter((key) => SharedPermissions.PERMISSION_META[key].dangerous)
    .sort();

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

  it('CONTROL: every resource fixture names a route that is still mounted', () => {
    // A fixture for a route that was renamed would silently stop being measured: `cellsOf` falls
    // back to one empty cell, and the snapshot would lose its second dimension without a diff that
    // says why.
    const routes = new Set(guardedRoutes().map((route) => keyOf(route)));

    expect(Object.keys(FIXTURES).filter((route) => !routes.has(route))).toEqual([]);
    expect(Object.keys(FIXTURES).length).toBeGreaterThan(0);
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
        `${JSON.stringify(
          {
            catalogSize: SharedPermissions.PERMISSIONS.length,
            dangerous: dangerousKeys(),
            matrix: measured,
          },
          null,
          2,
        )}\n`,
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

  /**
   * The `dangerous` set travels with the matrix for the same reason its size does, and for one more.
   *
   * The flag is not decoration: it is what makes an endpoint demand `X-Confirm-Dangerous` and what
   * raises the severity of the trail entry. Losing it on a key is therefore a widening of access
   * that the matrix above cannot see — the cell still says `allow`, because the caller still holds
   * the permission; what changed is the ceremony around using it.
   *
   * `packages/shared/test/permissions/catalog.test.ts` states the rule for the bypass verbs
   * (`override`, `unlock`, `reopen`) over the whole catalogue, and pins `organization:delete` by
   * name. Everything else — `user:suspend`, `vault_item:export`, the rest — rests on this list: not
   * a rule about which keys deserve the flag, but a record of which ones carry it, so that adding,
   * removing or **moving** it between two keys is a diff a reviewer is shown. A count alone would
   * survive the move.
   */
  it('was taken against the same set of dangerous keys', () => {
    expect(readSnapshot().dangerous).toEqual(dangerousKeys());
  });
});
