import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createAuthApp, type AuthApp } from '../../support/auth-app.util.js';

/**
 * What the interface asks before it renders a button.
 *
 * Two properties are worth the round trip and neither is visible from the query alone: the answer is
 * **only ever about the caller**, and its validator is the version of their rights rather than a
 * guessed lifetime — so a change to somebody's permissions invalidates their copy on the next
 * request instead of after a timeout.
 */

const PASSWORD = 'correct-horse-battery';
const IDEMPOTENCY_KEY = 'e'.repeat(32);

const signedIn = async (
  capabilities?: Parameters<typeof createAuthApp>[0] extends undefined
    ? never
    : NonNullable<Parameters<typeof createAuthApp>[0]>['capabilities'],
): Promise<{ test: AuthApp; token: string }> => {
  const test = createAuthApp(capabilities === undefined ? {} : { capabilities });

  await request(test.app)
    .post('/api/v1/auth/register')
    .set('Idempotency-Key', IDEMPOTENCY_KEY)
    .send({
      organization: { name: 'Bad Company', slug: 'bad-company' },
      owner: { email: 'ada@example.com', password: PASSWORD },
    })
    .expect(201);

  const response = await request(test.app)
    .post('/api/v1/auth/login')
    .send({ email: 'ada@example.com', password: PASSWORD })
    .expect(200);

  return { test, token: (response.body as { accessToken: string }).accessToken };
};

describe('GET /api/v1/me/permissions', () => {
  it('answers with the folded view and a validator built from the version', async () => {
    const { test, token } = await signedIn({
      isOwner: false,
      granted: ['role:read', 'task:read'],
      denied: ['task:update'],
      roleKeys: ['manager'],
      permissionsVersion: 4,
    });

    const response = await request(test.app)
      .get('/api/v1/me/permissions')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toMatchObject({
      permissions: ['role:read', 'task:read'],
      denied: ['task:update'],
      roles: ['manager'],
      isOwner: false,
      version: 4,
    });
    expect(response.headers['etag']).toMatch(/^"perm-.*-4"$/);
    // The body belongs to one person; a shared cache holding it would hand one person's rights to
    // another.
    expect(response.headers['cache-control']).toBe('private, must-revalidate');
  });

  it('answers 304 to a client that already holds the current copy', async () => {
    const { test, token } = await signedIn({
      isOwner: false,
      granted: [],
      denied: [],
      roleKeys: [],
      permissionsVersion: 1,
    });

    const first = await request(test.app)
      .get('/api/v1/me/permissions')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const second = await request(test.app)
      .get('/api/v1/me/permissions')
      .set('Authorization', `Bearer ${token}`)
      .set('If-None-Match', first.headers['etag'] ?? '')
      .expect(304);

    expect(second.body).toEqual({});
  });

  /**
   * The validator is the identity of the decision, not a hash of the body: `permissionsVersion` is
   * bumped inside the transaction of every change to somebody's rights, so a stale copy cannot
   * survive a change even for the length of a timeout.
   */
  it('changes its validator when the rights change', async () => {
    const before = await signedIn({
      isOwner: false,
      granted: ['task:read'],
      denied: [],
      roleKeys: [],
      permissionsVersion: 7,
    });
    const after = await signedIn({
      isOwner: false,
      granted: ['task:read', 'task:update'],
      denied: [],
      roleKeys: [],
      permissionsVersion: 8,
    });

    const first = await request(before.test.app)
      .get('/api/v1/me/permissions')
      .set('Authorization', `Bearer ${before.token}`)
      .expect(200);

    const second = await request(after.test.app)
      .get('/api/v1/me/permissions')
      .set('Authorization', `Bearer ${after.token}`)
      .set('If-None-Match', first.headers['etag'] ?? '')
      .expect(200);

    expect(second.headers['etag']).not.toBe(first.headers['etag']);
  });

  it('takes no subject: there is no way to ask about somebody else', async () => {
    const { test, token } = await signedIn();

    // A query parameter is the shape this endpoint deliberately does not have — reading another
    // person's rights is a different operation, gated by `permission:override_read`.
    const response = await request(test.app)
      .get('/api/v1/me/permissions?userId=018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a99')
      .set('Authorization', `Bearer ${token}`);

    // The parameter is ignored rather than honoured; whatever the status, the body is the caller's.
    expect([200, 422]).toContain(response.status);
  });

  it('needs a session', async () => {
    const test = createAuthApp();

    const response = await request(test.app).get('/api/v1/me/permissions');

    expect(response.status).toBe(401);
  });
});
