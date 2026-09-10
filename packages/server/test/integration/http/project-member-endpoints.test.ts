import { type SharedPermissions } from '@bad-crm/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createAuthApp, type AuthApp, type AuthAppOptions } from '../../support/auth-app.util.js';
import {
  ORGANIZATION_ID,
  OTHER_ORGANIZATION_ID,
  USER_ID,
} from '../../support/identity-doubles.util.js';
import { FakeProjectStore } from '../../support/project-doubles.util.js';

/**
 * The roster routes over the wire — STORY-014-02, acceptance 1, 4, 5, 6, 7, 8, 9, 10 and 11, on
 * the mounted seam with in-memory ports.
 *
 * Every membership change is a change of rights here, unlike on a team: `projectRole` is the
 * source of the implicit level, so each one bumps the person's folded view and is filed at
 * `WARNING`. What the wire adds to the use-case suites: the validator's refusals (`allocationPct`
 * out of range, an empty patch), the self-join filed as a refused mutation, and the closed contour
 * on the roster of a `PRIVATE` project.
 */

const PASSWORD = 'correct-horse-battery';
const IDEMPOTENCY_KEY = 'e'.repeat(32);
const PROJECT_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b01';
const OTHER_PROJECT_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b02';
const DELETED_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b03';
const NOBODYS_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5bff';
const IVAN = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b11';
const PETR = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b12';
const SUSPENDED = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b14';

const holder = (granted: readonly SharedPermissions.PermissionKey[]) => ({
  isOwner: false,
  granted: [...granted],
  denied: [] as SharedPermissions.PermissionKey[],
  roleKeys: [] as string[],
  permissionsVersion: 1,
});

const MANAGER = holder(['project:read', 'project:manage_members']);

const signedIn = async (
  options: AuthAppOptions = {},
): Promise<{ test: AuthApp; token: string }> => {
  const test = createAuthApp(options);

  await request(test.server())
    .post('/api/v1/auth/register')
    .set('Idempotency-Key', IDEMPOTENCY_KEY)
    .send({
      organization: { name: 'Bad Company', slug: 'bad-company' },
      owner: { email: 'ada@example.com', password: PASSWORD },
    })
    .expect(201);

  const response = await request(test.server())
    .post('/api/v1/auth/login')
    .send({ email: 'ada@example.com', password: PASSWORD })
    .expect(200);

  return { test, token: (response.body as { accessToken: string }).accessToken };
};

/** The caller leads the project; Ivan is a MEMBER on it; Petr and a suspended account are subjects. */
const seeded = (
  visibility: 'PUBLIC_ORG' | 'PRIVATE' = 'PUBLIC_ORG',
  callerRole: 'LEAD' | 'MEMBER' | null = 'LEAD',
): FakeProjectStore => {
  const projects = new FakeProjectStore();

  projects.seed({
    projectId: PROJECT_ID,
    organizationId: ORGANIZATION_ID,
    visibility,
    leadId: USER_ID,
  });

  if (callerRole !== null) projects.addMember(PROJECT_ID, USER_ID, callerRole);
  projects.addMember(PROJECT_ID, IVAN, 'MEMBER', 50);

  projects.subjects.set(USER_ID, { userId: USER_ID, status: 'ACTIVE' });
  projects.subjects.set(IVAN, { userId: IVAN, status: 'ACTIVE' });
  projects.subjects.set(PETR, { userId: PETR, status: 'ACTIVE' });
  projects.subjects.set(SUSPENDED, { userId: SUSPENDED, status: 'SUSPENDED' });

  return projects;
};

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const add = (test: AuthApp, token: string, body: object, projectId = PROJECT_ID): request.Test =>
  request(test.server())
    .post(`/api/v1/projects/${projectId}/members`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', IDEMPOTENCY_KEY)
    .send(body);

const change = (
  test: AuthApp,
  token: string,
  userId: string,
  body: object,
  projectId = PROJECT_ID,
): request.Test =>
  request(test.server())
    .patch(`/api/v1/projects/${projectId}/members/${userId}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);

const remove = (
  test: AuthApp,
  token: string,
  userId: string,
  projectId = PROJECT_ID,
): request.Test =>
  request(test.server())
    .delete(`/api/v1/projects/${projectId}/members/${userId}`)
    .set('Authorization', `Bearer ${token}`);

const roster = (test: AuthApp, token: string, query = ''): request.Test =>
  request(test.server())
    .get(`/api/v1/projects/${PROJECT_ID}/members${query}`)
    .set('Authorization', `Bearer ${token}`);

describe('GET /api/v1/projects/{projectId}/members', () => {
  it('CONTROL: a reader gets the live roster as ids, whitelisted field by field', async () => {
    const { test, token } = await signedIn({
      capabilities: holder(['project:read']),
      projects: seeded(),
    });

    const response = await roster(test, token).expect(200);

    expect(response.body).toEqual({
      items: [
        {
          userId: USER_ID,
          projectRole: 'LEAD',
          allocationPct: 100,
          joinedAt: expect.any(String),
          leftAt: null,
        },
        {
          userId: IVAN,
          projectRole: 'MEMBER',
          allocationPct: 50,
          joinedAt: expect.any(String),
          leftAt: null,
        },
      ],
    });
  });

  /** Acceptance 10: the people who left are shown only on request. */
  it('shows the memberships that ended only with includeLeft=true', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });

    await remove(test, token, IVAN).expect(204);

    const live = await roster(test, token).expect(200);

    expect((live.body as { items: { userId: string }[] }).items.map((m) => m.userId)).toEqual([
      USER_ID,
    ]);

    const all = await roster(test, token, '?includeLeft=true').expect(200);

    expect((all.body as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ userId: USER_ID, leftAt: null }),
      expect.objectContaining({ userId: IVAN, leftAt: expect.any(String) }),
    ]);
  });

  /** Acceptance 3: the roster of a PRIVATE project is the same 404 to an outsider as the project. */
  it('answers 404 for the roster of a PRIVATE project the caller is not on, and 403 without the key', async () => {
    const outsider = await signedIn({
      capabilities: holder(['project:read']),
      projects: seeded('PRIVATE', null),
    });

    const hidden = await roster(outsider.test, outsider.token).expect(404);

    expect(hidden.body).toMatchObject({ code: 'project_not_found' });

    const keyless = await signedIn({ projects: seeded() });

    await roster(keyless.test, keyless.token).expect(403);
  });
});

describe('POST /api/v1/projects/{projectId}/members', () => {
  /** Acceptance 1: the seat, the bump, the entry. */
  it('CONTROL: a LEAD adds a colleague, bumps them and files project.member_added', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });

    await add(test, token, { userId: PETR, projectRole: 'REVIEWER', allocationPct: 30 }).expect(
      204,
    );

    await expect(projects.membershipOf(PROJECT_ID, PETR)).resolves.toEqual({
      projectRole: 'REVIEWER',
      allocationPct: 30,
    });
    expect(projects.versionBumps).toEqual([PETR]);
    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'project.member_added',
      target: { type: 'PROJECT', id: PROJECT_ID },
      after: { userId: PETR, projectRole: 'REVIEWER', allocationPct: 30 },
    });
  });

  /** Acceptance 6, `T-PROJ-02`: one's own id is refused with the key held, and the refusal is filed. */
  it('refuses the caller’s own id as 403 self_assignment_forbidden, and files the refused mutation', async () => {
    const projects = seeded('PUBLIC_ORG', null);

    projects.addMember(PROJECT_ID, PETR, 'LEAD');

    const { test, token } = await signedIn({
      capabilities: { ...MANAGER, isOwner: true },
      projects,
    });

    const response = await add(test, token, { userId: USER_ID }).expect(403);
    await settled();

    expect(response.body).toMatchObject({
      code: 'project_forbidden',
      reason: 'self_assignment_forbidden',
    });
    expect(test.audit.events.filter((event) => event.action === 'access.denied')).toHaveLength(1);
    expect(projects.trace).not.toContain('add');
  });

  /** Acceptance 6, the first half: `project:read` alone does not add anybody. */
  it('refuses a caller with project:read only, before any port is asked', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ capabilities: holder(['project:read']), projects });

    const response = await add(test, token, { userId: PETR }).expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
    expect(projects.trace).toEqual([]);
  });

  /** Acceptance 8: a foreign account is 404; a suspended one 409, and only with `user:read`. */
  it('answers 404 for a foreign account and 409 member_not_active for a suspended one', async () => {
    const { test, token } = await signedIn({
      capabilities: holder(['project:read', 'project:manage_members', 'user:read']),
      projects: seeded(),
    });

    const foreign = await add(test, token, { userId: NOBODYS_ID }).expect(404);

    expect(foreign.body).toMatchObject({ code: 'user_not_found' });

    const suspended = await add(test, token, { userId: SUSPENDED }).expect(409);

    expect(suspended.body).toMatchObject({ code: 'member_not_active' });

    const blind = await signedIn({ capabilities: MANAGER, projects: seeded() });

    await add(blind.test, blind.token, { userId: SUSPENDED }).expect(404);
  });

  /** Acceptance 9: the allocation is validated at the boundary. */
  it.each([
    ['an allocation above 100', { userId: PETR, allocationPct: 150 }, 'allocationPct'],
    ['a negative allocation', { userId: PETR, allocationPct: -1 }, 'allocationPct'],
    ['a fractional allocation', { userId: PETR, allocationPct: 12.5 }, 'allocationPct'],
    ['a role outside the list', { userId: PETR, projectRole: 'OWNER' }, 'projectRole'],
    ['a userId that is not a uuid', { userId: 'petr' }, 'userId'],
  ])('refuses %s with 422 on the field', async (_case, body, path) => {
    const { test, token } = await signedIn({ capabilities: MANAGER, projects: seeded() });

    const response = await add(test, token, body).expect(422);

    expect(response.body).toMatchObject({ code: 'validation_failed' });
    expect((response.body as { errors: { path: string }[] }).errors.map((e) => e.path)).toContain(
      path,
    );
  });

  it('is a silent 204 for a repeat with the same seat, and a filed role change for a different role', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });

    await add(test, token, { userId: IVAN, projectRole: 'MEMBER', allocationPct: 50 }).expect(204);

    expect(test.audit.events.filter((event) => event.action.startsWith('project.member'))).toEqual(
      [],
    );

    await add(test, token, { userId: IVAN, projectRole: 'LEAD', allocationPct: 50 }).expect(204);

    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'project.member_role_changed',
      before: { userId: IVAN, projectRole: 'MEMBER' },
      after: { userId: IVAN, projectRole: 'LEAD' },
    });
    expect(projects.versionBumps).toEqual([IVAN]);
  });

  it('answers 404 for a PRIVATE project the caller is not on, for a foreign one and for a deleted one', async () => {
    const projects = seeded('PRIVATE', null);

    projects.seed({ projectId: OTHER_PROJECT_ID, organizationId: OTHER_ORGANIZATION_ID });
    projects.seed({ projectId: DELETED_ID, organizationId: ORGANIZATION_ID, isDeleted: true });

    const { test, token } = await signedIn({ capabilities: MANAGER, projects });
    const bodies: Record<string, unknown>[] = [];

    for (const projectId of [PROJECT_ID, OTHER_PROJECT_ID, DELETED_ID, NOBODYS_ID]) {
      const response = await add(test, token, { userId: PETR }, projectId).expect(404);
      const { requestId, ...body } = response.body as Record<string, unknown>;

      expect(requestId).toEqual(expect.any(String));
      bodies.push(body);
    }

    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ code: 'project_not_found' });
  });
});

describe('PATCH /api/v1/projects/{projectId}/members/{userId}', () => {
  /** Acceptance 4: the role moves, the version moves, the entry has both sides. */
  it('CONTROL: promotes a MEMBER to LEAD and files both sides', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });

    await change(test, token, IVAN, { projectRole: 'LEAD' }).expect(204);

    await expect(projects.membershipOf(PROJECT_ID, IVAN)).resolves.toEqual({
      projectRole: 'LEAD',
      allocationPct: 50,
    });
    expect(projects.versionBumps).toEqual([IVAN]);
    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'project.member_role_changed',
      before: { userId: IVAN, projectRole: 'MEMBER', allocationPct: 50 },
      after: { userId: IVAN, projectRole: 'LEAD', allocationPct: 50 },
    });
  });

  it('changes the allocation alone without a bump or an entry', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });

    await change(test, token, IVAN, { allocationPct: 80 }).expect(204);

    await expect(projects.membershipOf(PROJECT_ID, IVAN)).resolves.toMatchObject({
      allocationPct: 80,
    });
    expect(projects.versionBumps).toEqual([]);
    expect(test.audit.events.filter((event) => event.action.startsWith('project.member'))).toEqual(
      [],
    );
  });

  it('refuses an empty patch and an unknown field with 422', async () => {
    const { test, token } = await signedIn({ capabilities: MANAGER, projects: seeded() });

    const empty = await change(test, token, IVAN, {}).expect(422);
    const unknown = await change(test, token, IVAN, { teamRole: 'LEAD' }).expect(422);

    expect(empty.body).toMatchObject({ code: 'validation_failed' });
    expect(unknown.body).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: 'teamRole', code: 'unrecognized_keys' }],
    });
  });

  /** Acceptance 7: the only lead cannot be demoted — by an owner off the roster, since one's own role is off limits. */
  it('answers 409 last_project_lead_required when demoting the only lead', async () => {
    const projects = seeded('PUBLIC_ORG', null);

    projects.addMember(PROJECT_ID, PETR, 'LEAD');

    const { test, token } = await signedIn({
      capabilities: { ...MANAGER, isOwner: true },
      projects,
    });

    const response = await change(test, token, PETR, { projectRole: 'OBSERVER' }).expect(409);

    expect(response.body).toMatchObject({ code: 'last_project_lead_required' });
  });

  /** The security gate's finding: one's own role is not one's to raise, whatever the grant. */
  it('refuses the caller raising their own role as 403 self_assignment_forbidden', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...MANAGER, isOwner: true },
      projects: seeded('PUBLIC_ORG', 'MEMBER'),
    });

    const response = await change(test, token, USER_ID, { projectRole: 'LEAD' }).expect(403);
    await settled();

    expect(response.body).toMatchObject({ reason: 'self_assignment_forbidden' });
    // A refused mutation is filed, on this path as on `POST`.
    expect(test.audit.events.filter((event) => event.action === 'access.denied')).toHaveLength(1);
  });

  it('answers 404 user_not_found for somebody who is not on the project', async () => {
    const { test, token } = await signedIn({ capabilities: MANAGER, projects: seeded() });

    const response = await change(test, token, PETR, { projectRole: 'LEAD' }).expect(404);

    expect(response.body).toMatchObject({ code: 'user_not_found' });
  });

  /** A MEMBER holding the key is one level short: 403 inside the contour. */
  it('refuses an EDITOR holding the key with insufficient_acl_level', async () => {
    const { test, token } = await signedIn({
      capabilities: MANAGER,
      projects: seeded('PUBLIC_ORG', 'MEMBER'),
    });

    const response = await change(test, token, IVAN, { projectRole: 'LEAD' }).expect(403);

    expect(response.body).toMatchObject({ reason: 'insufficient_acl_level' });
  });
});

describe('DELETE /api/v1/projects/{projectId}/members/{userId}', () => {
  /** Acceptance 5: the row stays with `leftAt`, the version moves, the entry carries `before`. */
  it('CONTROL: ends the membership, keeps the row, bumps and files before', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });

    await remove(test, token, IVAN).expect(204);

    await expect(projects.membershipOf(PROJECT_ID, IVAN)).resolves.toBeNull();
    await expect(projects.roster(PROJECT_ID, { includeLeft: true })).resolves.toEqual([
      expect.objectContaining({ userId: USER_ID, leftAt: null }),
      expect.objectContaining({ userId: IVAN, leftAt: expect.any(Date) }),
    ]);
    expect(projects.versionBumps).toEqual([IVAN]);
    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'project.member_removed',
      before: { userId: IVAN, projectRole: 'MEMBER', allocationPct: 50 },
    });
  });

  /** Acceptance 7: the only lead does not leave; a second lead may. */
  it('answers 409 for the only lead, and lets a lead go once another one exists', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });

    const refused = await remove(test, token, USER_ID).expect(409);

    expect(refused.body).toMatchObject({ code: 'last_project_lead_required' });

    await change(test, token, IVAN, { projectRole: 'LEAD' }).expect(204);
    await remove(test, token, USER_ID).expect(204);

    await expect(projects.leads(PROJECT_ID)).resolves.toEqual([IVAN]);
  });

  it('answers 404 for somebody who is not on the project, and for a project the caller cannot see', async () => {
    const { test, token } = await signedIn({ capabilities: MANAGER, projects: seeded() });

    const absent = await remove(test, token, PETR).expect(404);

    expect(absent.body).toMatchObject({ code: 'user_not_found' });

    const outsider = await signedIn({ capabilities: MANAGER, projects: seeded('PRIVATE', null) });
    const hidden = await remove(outsider.test, outsider.token, IVAN).expect(404);

    expect(hidden.body).toMatchObject({ code: 'project_not_found' });
  });
});
