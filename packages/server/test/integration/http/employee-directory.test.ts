import { type SharedPermissions } from '@bad-crm/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { directoryRow, FakeEmployeeDirectoryRepository } from '../../support/iam-doubles.util.js';
import { createAuthApp, type AuthApp, type AuthAppOptions } from '../../support/auth-app.util.js';

/**
 * The directory over HTTP.
 *
 * What only shows up at this level is the **query string**: a repeated parameter and a single one
 * have to mean the same thing, an unknown value has to be refused rather than defaulted, and the
 * route has to be reachable at all — `/employees/org-chart` is declared before `/employees/:userId`,
 * and a registry that lost that order would answer 400 for a `userId` that is not a UUID.
 */

const IDEMPOTENCY_KEY = 'f'.repeat(32);
const PASSWORD = 'correct-horse-battery';
const OWNER = 'ada@example.com';
const COLLEAGUE = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5ae1';
const ROLE = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af2';
const TEAM = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af3';

const capabilities = (
  granted: readonly SharedPermissions.PermissionKey[],
): NonNullable<AuthAppOptions['capabilities']> => ({
  isOwner: false,
  granted: [...granted],
  denied: [],
  roleKeys: [],
  permissionsVersion: 1,
});

const signedIn = async (
  options: AuthAppOptions = {},
): Promise<{ test: AuthApp; token: string; userId: string }> => {
  const test = createAuthApp(options);

  await request(test.app)
    .post('/api/v1/auth/register')
    .set('Idempotency-Key', IDEMPOTENCY_KEY)
    .send({
      organization: { name: 'Bad Company', slug: 'bad-company' },
      owner: { email: OWNER, password: PASSWORD },
    })
    .expect(201);

  const response = await request(test.app)
    .post('/api/v1/auth/login')
    .send({ email: OWNER, password: PASSWORD })
    .expect(200);

  const body = response.body as { accessToken: string; user: { id: string } };

  return { test, token: body.accessToken, userId: body.user.id };
};

const populated = (): FakeEmployeeDirectoryRepository => {
  const directory = new FakeEmployeeDirectoryRepository();

  directory.rows.push(
    directoryRow({
      userId: COLLEAGUE,
      firstName: 'Ivan',
      lastName: 'Petrov',
      roles: [{ id: ROLE, key: 'developer', name: 'Developer' }],
      teams: [{ id: TEAM, name: 'Platform' }],
    }),
    directoryRow({
      userId: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af4',
      firstName: 'Olga',
      lastName: 'Zhukova',
      status: 'SUSPENDED',
    }),
  );

  return directory;
};

const list = (test: AuthApp, token: string, query = ''): request.Test =>
  request(test.app).get(`/api/v1/employees${query}`).set('Authorization', `Bearer ${token}`);

interface ListBody {
  readonly items: { userId: string; lastName: string; hiredAt?: string }[];
  readonly total: number;
  readonly sort: string;
  readonly facets: { roles: { id: string }[]; teams: { id: string }[] };
}

describe('GET /api/v1/employees', () => {
  it('refuses somebody without employee:read', async () => {
    const { test, token } = await signedIn({ capabilities: capabilities([]) });

    const response = await list(test, token).expect(403);

    expect((response.body as { reason: string }).reason).toBe('permission_not_granted');
  });

  it('answers the people who work here, with the facets its filters need', async () => {
    const employeeDirectory = populated();
    const { test, token } = await signedIn({
      employeeDirectory,
      capabilities: capabilities(['employee:read']),
    });

    const body = (await list(test, token).expect(200)).body as ListBody;

    // Deactivated hidden by default; the facets carry the role and the team, because the screen
    // cannot ask `/roles` or `/teams` — a developer holds neither `role:read` nor `team:read`.
    expect(body.items.map((item) => item.lastName)).toEqual(['Petrov']);
    expect(body.total).toBe(1);
    expect(body.facets.roles).toEqual([{ id: ROLE, key: 'developer', name: 'Developer' }]);
    expect(body.facets.teams).toEqual([{ id: TEAM, name: 'Platform' }]);
  });

  it('reads a repeated parameter and a single one the same way', async () => {
    const employeeDirectory = populated();
    const { test, token } = await signedIn({
      employeeDirectory,
      capabilities: capabilities(['employee:read']),
    });

    const one = (await list(test, token, '?status=SUSPENDED').expect(200)).body as ListBody;
    const two = (await list(test, token, '?status=SUSPENDED&status=ACTIVE').expect(200))
      .body as ListBody;

    expect(one.items.map((item) => item.lastName)).toEqual(['Zhukova']);
    expect(two.items.map((item) => item.lastName)).toEqual(['Petrov', 'Zhukova']);
  });

  it('refuses a status nobody could have meant', async () => {
    const { test, token } = await signedIn({ capabilities: capabilities(['employee:read']) });

    // A 400 rather than «here is everybody»: on the server an unknown value means a client sent
    // something it should not have, and a plausible page would hide the defect. The client falls
    // back instead, because there a hand-edited address bar must not become an error screen.
    const response = await list(test, token, '?status=RETIRED').expect(422);

    expect((response.body as { code: string }).code).toBe('validation_failed');
  });

  it('refuses an unknown parameter outright', async () => {
    const { test, token } = await signedIn({ capabilities: capabilities(['employee:read']) });

    const response = await list(test, token, '?department=Platform').expect(422);

    expect((response.body as { code: string }).code).toBe('validation_failed');
  });

  it('sends back an order by name when the caller may not read hiring dates', async () => {
    const employeeDirectory = populated();
    const { test, token } = await signedIn({
      employeeDirectory,
      capabilities: capabilities(['employee:read']),
    });

    const body = (await list(test, token, '?sort=hiredAt').expect(200)).body as ListBody;

    expect(body.sort).toBe('name');
    // And the row itself carries no hiring date either — the two are the same decision.
    expect(body.items[0]).not.toHaveProperty('hiredAt');
  });

  it('keeps the order and the dates for HR', async () => {
    const employeeDirectory = populated();
    const { test, token } = await signedIn({
      employeeDirectory,
      capabilities: capabilities(['employee:read', 'employee:view_personal_data']),
    });

    const body = (await list(test, token, '?sort=hiredAt').expect(200)).body as ListBody;

    expect(body.sort).toBe('hiredAt');
    expect(body.items[0]?.hiredAt).toBe('2024-03-01');
  });
});

describe('GET /api/v1/employees/org-chart', () => {
  const chart = (test: AuthApp, token: string): request.Test =>
    request(test.app).get('/api/v1/employees/org-chart').set('Authorization', `Bearer ${token}`);

  it('is a route of its own, not a personnel record called «org-chart»', async () => {
    const employeeDirectory = populated();
    const { test, token } = await signedIn({
      employeeDirectory,
      capabilities: capabilities(['employee:view_org_chart']),
    });

    const body = (await chart(test, token).expect(200)).body as { nodes: { userId: string }[] };

    expect(body.nodes).toHaveLength(2);
  });

  it('needs its own capability, which employee:read does not include', async () => {
    const { test, token } = await signedIn({ capabilities: capabilities(['employee:read']) });

    const response = await chart(test, token).expect(403);

    expect((response.body as { reason: string }).reason).toBe('permission_not_granted');
  });
});
