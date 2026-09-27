import { type SharedPermissions } from '@bad-crm/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createAuthApp, type AuthApp, type AuthAppOptions } from '../../support/auth-app.util.js';
import { ORGANIZATION_ID, USER_ID } from '../../support/identity-doubles.util.js';
import { FakeProjectStore } from '../../support/project-doubles.util.js';

/**
 * `GET /projects/{projectId}/visibility-impact` over the wire — STORY-014-01, acceptance 7, on the
 * mounted seam: guard, validator, query, policy, serializer, error handler, with in-memory ports.
 *
 * The counts themselves are held against the per-colleague read decision on a live database
 * (`test/integration/db/project-visibility-impact.test.ts`); here the route is held to its contract —
 * the two counts and nothing else, the change's own key and level, one 404 for every outsider, a
 * `422` for a `to` outside the closed list.
 */

const PASSWORD = 'correct-horse-battery';
const IDEMPOTENCY_KEY = 'f'.repeat(32);
const PROJECT_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b01';
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

const MANAGES = holder(['project:read', 'project:manage_visibility']);

const signedIn = async (options: AuthAppOptions): Promise<{ test: AuthApp; token: string }> => {
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

/** The caller seated as `role`; Ivan and Petr active bystanders, Petr with a grant; one suspended. */
const seeded = (
  visibility: 'PUBLIC_ORG' | 'PRIVATE',
  role: 'LEAD' | 'MEMBER' | null,
): FakeProjectStore => {
  const projects = new FakeProjectStore();

  projects.seed({ projectId: PROJECT_ID, organizationId: ORGANIZATION_ID, visibility });

  if (role !== null) projects.addMember(PROJECT_ID, USER_ID, role);

  projects.subjects.set(USER_ID, { userId: USER_ID, status: 'ACTIVE' });
  projects.subjects.set(IVAN, { userId: IVAN, status: 'ACTIVE' });
  projects.subjects.set(PETR, { userId: PETR, status: 'ACTIVE' });
  projects.subjects.set(SUSPENDED, { userId: SUSPENDED, status: 'SUSPENDED' });
  projects.audienceGrants.push({ userId: PETR, depth: 0, level: 'VIEWER', expiresAt: null });

  return projects;
};

const preview = (test: AuthApp, token: string, query: string, projectId = PROJECT_ID) =>
  request(test.server())
    .get(`/api/v1/projects/${projectId}/visibility-impact${query}`)
    .set('Authorization', `Bearer ${token}`);

describe('GET /projects/{projectId}/visibility-impact', () => {
  it('answers the two counts and nothing else', async () => {
    const { test, token } = await signedIn({
      capabilities: MANAGES,
      projects: seeded('PUBLIC_ORG', 'LEAD'),
    });

    const response = await preview(test, token, '?to=PRIVATE').expect(200);

    // Ivan loses it; Petr keeps it by his grant; the lead keeps it; the suspended account is no one.
    expect(response.body).toEqual({ losingAccess: 1, gainingAccess: 0 });
  });

  it('counts who would gain a private project opened to the organization', async () => {
    const { test, token } = await signedIn({
      capabilities: MANAGES,
      projects: seeded('PRIVATE', 'LEAD'),
    });

    const response = await preview(test, token, '?to=PUBLIC_ORG').expect(200);

    expect(response.body).toEqual({ losingAccess: 0, gainingAccess: 1 });
  });

  it.each([
    ['without `to`', ''],
    ['with a `to` outside the closed list', '?to=SECRET'],
    ['with an unknown parameter', '?to=PRIVATE&who=all'],
  ])('refuses a request %s as 422', async (_what, query) => {
    const { test, token } = await signedIn({
      capabilities: MANAGES,
      projects: seeded('PUBLIC_ORG', 'LEAD'),
    });

    const response = await preview(test, token, query).expect(422);

    expect(response.body).toMatchObject({ code: 'validation_failed' });
  });

  it('refuses an anonymous caller as 401', async () => {
    const test = createAuthApp({ capabilities: MANAGES, projects: seeded('PUBLIC_ORG', 'LEAD') });

    const response = await request(test.server())
      .get(`/api/v1/projects/${PROJECT_ID}/visibility-impact?to=PRIVATE`)
      .expect(401);

    expect(response.body).toMatchObject({ code: 'unauthenticated' });
  });

  it('refuses a caller without the key as 403, before the project is looked at', async () => {
    const { test, token } = await signedIn({
      capabilities: holder(['project:read']),
      projects: seeded('PUBLIC_ORG', 'LEAD'),
    });

    const response = await preview(test, token, '?to=PRIVATE').expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
  });

  it('refuses a holder of the key below MANAGER as 403', async () => {
    const { test, token } = await signedIn({
      capabilities: MANAGES,
      projects: seeded('PUBLIC_ORG', 'MEMBER'),
    });

    const response = await preview(test, token, '?to=PRIVATE').expect(403);

    expect(response.body).toMatchObject({ reason: 'insufficient_acl_level' });
  });

  it('answers a private project the caller is not on and an id that names nothing alike: 404', async () => {
    const { test, token } = await signedIn({
      capabilities: MANAGES,
      projects: seeded('PRIVATE', null),
    });

    const hidden = await preview(test, token, '?to=PUBLIC_ORG').expect(404);
    const nothing = await preview(test, token, '?to=PUBLIC_ORG', NOBODYS_ID).expect(404);

    const withoutRequestId = (body: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(body).filter(([key]) => key !== 'requestId' && key !== 'instance'),
      );

    expect(hidden.body).toMatchObject({ code: 'project_not_found' });
    expect(withoutRequestId(hidden.body as Record<string, unknown>)).toEqual(
      withoutRequestId(nothing.body as Record<string, unknown>),
    );
  });
});
