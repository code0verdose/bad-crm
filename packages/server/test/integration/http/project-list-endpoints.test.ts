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
 * `GET /api/v1/projects` over the wire — STORY-014-04, the server half.
 *
 * What is measured here is the **seam**: guard, validator, query, plan, serializer, error handler
 * over the real HTTP surface and in-memory ports. Whether the SQL means what the plan means is
 * `test/integration/db/project-list.test.ts` (the list against `can()` project by project, on a
 * live PostgreSQL); whether the plan means what `can()` means is `visible-projects-policy.test.ts`.
 *
 * Held here and nowhere else: the body is a **whitelist** — no key the contract does not name, no
 * money (acceptance 6) — hidden projects are absent from `items`, `total` and `facets` alike as the
 * client receives them (acceptance 5), `member=me` is a word the server resolves (acceptance 8),
 * and the edges of the query string are `422`, not a plausible page.
 */

const PASSWORD = 'correct-horse-battery';
const IDEMPOTENCY_KEY = 'f'.repeat(32);
const PUBLIC_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5c01';
const PRIVATE_MINE_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5c02';
const PRIVATE_THEIRS_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5c03';
const FOREIGN_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5c04';
const DELETED_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5c05';
const HIDDEN_LEAD = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5c99';

const READER = {
  isOwner: false,
  granted: ['project:read'] as SharedPermissions.PermissionKey[],
  denied: [] as SharedPermissions.PermissionKey[],
  roleKeys: [] as string[],
  permissionsVersion: 1,
};

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

/**
 * One organization's projects as a caller who is on exactly one private project sees them, plus a
 * neighbour's project and a deleted one — both of which must never surface.
 */
const store = (): FakeProjectStore => {
  const projects = new FakeProjectStore();

  projects.seed({
    projectId: PUBLIC_ID,
    organizationId: ORGANIZATION_ID,
    key: 'BAD',
    name: 'Bad CRM',
    leadId: USER_ID,
  });
  projects.seed({
    projectId: PRIVATE_MINE_ID,
    organizationId: ORGANIZATION_ID,
    key: 'MINE',
    name: 'Mine',
    visibility: 'PRIVATE',
    status: 'ON_HOLD',
    leadId: USER_ID,
  });
  projects.seed({
    projectId: PRIVATE_THEIRS_ID,
    organizationId: ORGANIZATION_ID,
    key: 'SECRET',
    name: 'Secret',
    visibility: 'PRIVATE',
    status: 'CLOSED',
    leadId: HIDDEN_LEAD,
  });
  projects.seed({
    projectId: FOREIGN_ID,
    organizationId: OTHER_ORGANIZATION_ID,
    key: 'BAD',
    name: 'Bad CRM elsewhere',
  });
  projects.seed({
    projectId: DELETED_ID,
    organizationId: ORGANIZATION_ID,
    key: 'GONE',
    name: 'Gone',
    isDeleted: true,
  });
  projects.addMember(PRIVATE_MINE_ID, USER_ID, 'MEMBER');

  return projects;
};

const listProjects = (test: AuthApp, token: string, query = ''): request.Test =>
  request(test.server()).get(`/api/v1/projects${query}`).set('Authorization', `Bearer ${token}`);

describe('GET /api/v1/projects', () => {
  it('CONTROL: lists what the caller can see, whitelisted field by field, no money', async () => {
    const { test, token } = await signedIn({ capabilities: READER, projects: store() });

    const response = await listProjects(test, token).expect(200);

    // `toEqual`, not `toMatchObject`: a leaked key — `organizationId`, `isDeleted`, a budget — is
    // exactly what a partial match would let through.
    expect(response.body).toEqual({
      items: [
        {
          id: PUBLIC_ID,
          key: 'BAD',
          name: 'Bad CRM',
          status: 'ACTIVE',
          visibility: 'PUBLIC_ORG',
          leadId: USER_ID,
          color: 'indigo',
          memberCount: 0,
        },
        {
          id: PRIVATE_MINE_ID,
          key: 'MINE',
          name: 'Mine',
          status: 'ON_HOLD',
          visibility: 'PRIVATE',
          leadId: USER_ID,
          color: 'indigo',
          memberCount: 1,
        },
      ],
      total: 2,
      page: 1,
      perPage: 25,
      sort: 'name',
      facets: { statuses: ['ACTIVE', 'ON_HOLD'], leadIds: [USER_ID] },
    });
  });

  it('a PRIVATE project the caller is not on is in no part of the answer', async () => {
    const { test, token } = await signedIn({ capabilities: READER, projects: store() });

    const response = await listProjects(test, token, '?status=CLOSED').expect(200);
    const body = JSON.stringify(response.body);

    expect(response.body).toMatchObject({ items: [], total: 0 });
    // Not by id, not by its status in the facets, not by its lead.
    expect(body).not.toContain(PRIVATE_THEIRS_ID);
    expect(body).not.toContain(HIDDEN_LEAD);
    expect((response.body as { facets: { statuses: string[] } }).facets.statuses).not.toContain(
      'CLOSED',
    );
  });

  it('CONTROL: the owner sees that project, and its lead in the facets', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...READER, isOwner: true, granted: [] },
      projects: store(),
    });

    const response = await listProjects(test, token, '?status=CLOSED').expect(200);

    expect(response.body).toMatchObject({ items: [{ id: PRIVATE_THEIRS_ID }], total: 1 });
    expect((response.body as { facets: { leadIds: string[] } }).facets.leadIds).toContain(
      HIDDEN_LEAD,
    );
  });

  it('member=me is the caller’s own membership', async () => {
    const { test, token } = await signedIn({ capabilities: READER, projects: store() });

    const response = await listProjects(test, token, '?member=me').expect(200);

    expect(response.body).toMatchObject({ items: [{ id: PRIVATE_MINE_ID }], total: 1 });
  });

  it('a repeated status is several values, a single one is one', async () => {
    const { test, token } = await signedIn({ capabilities: READER, projects: store() });

    const both = await listProjects(test, token, '?status=ACTIVE&status=ON_HOLD').expect(200);
    const one = await listProjects(test, token, '?status=ON_HOLD').expect(200);

    expect((both.body as { total: number }).total).toBe(2);
    expect(one.body).toMatchObject({ items: [{ id: PRIVATE_MINE_ID }], total: 1 });
  });

  it('a guest sees nothing without a grant, their own membership included', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...READER, roleKeys: ['guest'] },
      projects: store(),
    });

    const response = await listProjects(test, token).expect(200);

    // Even the project they are on: §5 «любой ресурс · роль guest → NONE» outranks the membership
    // row (`implicit-level.policy.ts`) — for a guest, silence is silence until a grant says more.
    expect(response.body).toMatchObject({ items: [], total: 0, facets: { statuses: [] } });
  });

  it('401 without a session', async () => {
    const test = createAuthApp({ projects: store() });

    const response = await request(test.server()).get('/api/v1/projects').expect(401);

    expect(response.body).toMatchObject({ code: 'unauthenticated' });
  });

  it('403 project_forbidden without project:read, before any project is read', async () => {
    const projects = store();
    const { test, token } = await signedIn({
      capabilities: { ...READER, granted: [] },
      projects,
    });

    const response = await listProjects(test, token).expect(403);

    expect(response.body).toMatchObject({ code: 'project_forbidden' });
    expect(projects.trace).toEqual([]);
  });

  it.each<[string, string]>([
    ['an unknown status', '?status=DONE'],
    ['a client filter, which does not exist yet', `?client=${USER_ID}`],
    ['member naming somebody', `?member=${USER_ID}`],
    ['a lead that is not an id', '?lead=ivan'],
    ['a page of 101', '?perPage=101'],
    ['a fractional page', '?page=1.5'],
    ['an order outside the list', '?sort=budget'],
  ])('422 on %s', async (_case, query) => {
    const { test, token } = await signedIn({ capabilities: READER, projects: store() });

    const response = await listProjects(test, token, query).expect(422);

    expect(response.body).toMatchObject({ code: 'validation_failed' });
  });

  it('503 service_unavailable when the grants cannot be read — not an empty list', async () => {
    const projects = store();

    projects.aclFailure = new Error('connection terminated');

    const { test, token } = await signedIn({ capabilities: READER, projects });

    const response = await listProjects(test, token).expect(503);

    expect(response.body).toMatchObject({ code: 'service_unavailable' });
    expect(projects.trace).not.toContain('page');
  });
});
