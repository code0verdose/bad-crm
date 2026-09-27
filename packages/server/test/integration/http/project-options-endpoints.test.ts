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
 * `GET /api/v1/projects/options` over the wire — STORY-014-06, the server half.
 *
 * The seam: guard, validator, query, plan, serializer, error handler, and the route's place before
 * `/projects/:projectId` (a shadowed route answers 422 for a non-UUID id, which the first case
 * would show). Held here: the body is a whitelist of five fields; hidden, foreign and deleted
 * projects are in neither `items` nor `recent`; the archive is out unless asked for; the edges of
 * the query string are 422.
 */

const PASSWORD = 'correct-horse-battery';
const IDEMPOTENCY_KEY = 'f'.repeat(32);
const PUBLIC_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5c01';
const PRIVATE_MINE_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5c02';
const PRIVATE_THEIRS_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5c03';
const FOREIGN_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5c04';
const DELETED_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5c05';
const ARCHIVED_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5c06';
const NOBODY_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5c07';

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
  projects.seed({
    projectId: ARCHIVED_ID,
    organizationId: ORGANIZATION_ID,
    key: 'OLD',
    name: 'Old',
    status: 'ARCHIVED',
  });
  projects.addMember(PRIVATE_MINE_ID, USER_ID, 'MEMBER');

  return projects;
};

const options = (test: AuthApp, token: string, query = ''): request.Test =>
  request(test.server())
    .get(`/api/v1/projects/options${query}`)
    .set('Authorization', `Bearer ${token}`);

const ids = (rows: unknown): string[] => (rows as { id: string }[]).map((row) => row.id);

describe('GET /api/v1/projects/options', () => {
  it('CONTROL: offers what the caller can see, five fields a row, archive out', async () => {
    const { test, token } = await signedIn({ capabilities: READER, projects: store() });

    const response = await options(test, token).expect(200);

    // `toEqual`: a leaked key — `visibility`, `leadId`, `memberCount` — would pass a partial match.
    expect(response.body).toEqual({
      items: [
        { id: PUBLIC_ID, key: 'BAD', name: 'Bad CRM', status: 'ACTIVE', color: 'indigo' },
        { id: PRIVATE_MINE_ID, key: 'MINE', name: 'Mine', status: 'ON_HOLD', color: 'indigo' },
      ],
      hasMore: false,
      recent: [],
    });
  });

  it('lets the archive in when asked, and narrows by text', async () => {
    const { test, token } = await signedIn({ capabilities: READER, projects: store() });

    const archived = await options(test, token, '?archived=true').expect(200);
    const narrowed = await options(test, token, '?q=min').expect(200);

    expect(ids((archived.body as { items: unknown }).items)).toEqual([
      PUBLIC_ID,
      PRIVATE_MINE_ID,
      ARCHIVED_ID,
    ]);
    expect(ids((narrowed.body as { items: unknown }).items)).toEqual([PRIVATE_MINE_ID]);
  });

  it('answers only the recent ids the caller can still see', async () => {
    const { test, token } = await signedIn({ capabilities: READER, projects: store() });

    const query = [PRIVATE_MINE_ID, PRIVATE_THEIRS_ID, FOREIGN_ID, DELETED_ID, NOBODY_ID]
      .map((id) => `recent=${id}`)
      .join('&');
    const response = await options(test, token, `?q=bad&${query}`).expect(200);
    const body = response.body as { items: unknown; recent: unknown };

    // The text filter narrows the results, not the pinned recent ones.
    expect(ids(body.items)).toEqual([PUBLIC_ID]);
    expect(ids(body.recent)).toEqual([PRIVATE_MINE_ID]);
  });

  it('keeps an archived recent project out while the archive is off', async () => {
    const { test, token } = await signedIn({ capabilities: READER, projects: store() });

    const off = await options(test, token, `?recent=${ARCHIVED_ID}`).expect(200);
    const on = await options(test, token, `?recent=${ARCHIVED_ID}&archived=true`).expect(200);

    expect(ids((off.body as { recent: unknown }).recent)).toEqual([]);
    expect(ids((on.body as { recent: unknown }).recent)).toEqual([ARCHIVED_ID]);
  });

  it('403 project_forbidden without project:read, before any project is read', async () => {
    const projects = store();
    const { test, token } = await signedIn({ capabilities: { ...READER, granted: [] }, projects });

    const response = await options(test, token).expect(403);

    expect(response.body).toMatchObject({ code: 'project_forbidden' });
    expect(projects.trace).toEqual([]);
  });

  it('401 without a session', async () => {
    const { test } = await signedIn({ capabilities: READER, projects: store() });

    const response = await request(test.server()).get('/api/v1/projects/options').expect(401);

    expect(response.body).toMatchObject({ code: 'unauthenticated' });
  });

  it.each<[string, string]>([
    ['a flag that is not a boolean', '?archived=maybe'],
    ['a recent id that is not an id', '?recent=bad'],
    ['six recent ids', `?${Array.from({ length: 6 }, () => `recent=${PUBLIC_ID}`).join('&')}`],
    ['a text longer than a search', `?q=${'a'.repeat(65)}`],
    ['a parameter of the list', '?status=ACTIVE'],
  ])('422 on %s', async (_case, query) => {
    const { test, token } = await signedIn({ capabilities: READER, projects: store() });

    const response = await options(test, token, query).expect(422);

    expect(response.body).toMatchObject({ code: 'validation_failed' });
  });

  it('503 service_unavailable when the grants cannot be read — not an empty list', async () => {
    const projects = store();

    projects.aclFailure = new Error('connection terminated');

    const { test, token } = await signedIn({ capabilities: READER, projects });

    const response = await options(test, token).expect(503);

    expect(response.body).toMatchObject({ code: 'service_unavailable' });
    expect(projects.trace).not.toContain('options');
  });
});
