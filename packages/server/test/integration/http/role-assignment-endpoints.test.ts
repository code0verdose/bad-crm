import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { FakeUserRoleRepository } from '../../support/iam-doubles.util.js';
import { createAuthApp, type AuthApp, type AuthAppOptions } from '../../support/auth-app.util.js';

/**
 * The first two routes in this product gated by a capability, as a client sees them.
 *
 * What only the wire can show is the *order*: the guard refuses before the body is parsed, the
 * use-case refuses after the ids are resolved, and the two produce different statuses for reasons a
 * client acts on differently. Three of the four cases below are refusals, which is the point — a
 * permission surface is defined by what it says no to.
 */

const PASSWORD = 'correct-horse-battery';
const IDEMPOTENCY_KEY = 'b'.repeat(32);
const IVAN = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a31';
const ROLE = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a32';

const REGISTRATION = {
  organization: { name: 'Bad Company', slug: 'bad-company' },
  owner: { email: 'ada@example.com', password: PASSWORD },
};

const signedIn = async (options: AuthAppOptions = {}): Promise<{ test: AuthApp; token: string }> => {
  const test = createAuthApp(options);

  await request(test.app)
    .post('/api/v1/auth/register')
    .set('Idempotency-Key', IDEMPOTENCY_KEY)
    .send(REGISTRATION)
    .expect(201);

  const response = await request(test.app)
    .post('/api/v1/auth/login')
    .send({ email: 'ada@example.com', password: PASSWORD })
    .expect(200);

  return { test, token: (response.body as { accessToken: string }).accessToken };
};

describe('POST /api/v1/users/{userId}/roles', () => {
  it('refuses a caller with no role:assign, before the body is even parsed', async () => {
    const { test, token } = await signedIn();

    const response = await request(test.app)
      .post(`/api/v1/users/${IVAN}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      // Deliberately invalid: a 422 here would mean the validator ran first, i.e. that an
      // unauthorised caller can make the server parse whatever they send.
      .send({ roleId: 'not-a-uuid' })
      .expect(403);

    expect(response.body).toMatchObject({
      code: 'role_forbidden',
      reason: 'permission_not_granted',
    });
    expect(test.userRoles.assignments.size).toBe(0);
  });

  it('assigns the role and bumps the version when the caller holds the right', async () => {
    const { test, token } = await signedIn({
      capabilities: { isOwner: false, granted: ['role:assign', 'task:read'], denied: [], permissionsVersion: 3 },
    });

    await request(test.app)
      .post(`/api/v1/users/${IVAN}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ roleId: ROLE })
      .expect(204);

    expect([...test.userRoles.assignments]).toEqual([`${IVAN}:${ROLE}`]);
    // Without this the change would take effect only after the person signs in again.
    expect(test.userRoles.versionBumps).toEqual([IVAN]);
  });

  it('answers the same 204 when the person already holds the role', async () => {
    const userRoles = new FakeUserRoleRepository();

    userRoles.assignments.add(`${IVAN}:${ROLE}`);

    const { test, token } = await signedIn({
      capabilities: { isOwner: false, granted: ['role:assign', 'task:read'], denied: [], permissionsVersion: 1 },
      userRoles,
    });

    await request(test.app)
      .post(`/api/v1/users/${IVAN}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ roleId: ROLE })
      .expect(204);

    // The caller asked for a state and the state is there — but nothing *happened*, so no version
    // bump and no trail entry.
    expect(test.userRoles.versionBumps).toEqual([]);
  });

  it('answers 404 for a person of another organization, never 403', async () => {
    const { test, token } = await signedIn({
      capabilities: { isOwner: false, granted: ['role:assign', 'task:read'], denied: [], permissionsVersion: 1 },
      userRoles: new FakeUserRoleRepository({ knownUsers: [] }),
    });

    const response = await request(test.app)
      .post(`/api/v1/users/${IVAN}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ roleId: ROLE })
      .expect(404);

    // 403 would confirm that the id is real somewhere the caller cannot see (invariant 2).
    expect(response.body).toMatchObject({ code: 'role_not_found' });
  });

  it('rejects an expiry in the past rather than accepting a grant that never applies', async () => {
    const { test, token } = await signedIn({
      capabilities: { isOwner: false, granted: ['role:assign', 'task:read'], denied: [], permissionsVersion: 1 },
    });

    const response = await request(test.app)
      .post(`/api/v1/users/${IVAN}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ roleId: ROLE, expiresAt: '2020-01-01T00:00:00Z' })
      .expect(422);

    expect(response.body).toMatchObject({ code: 'validation_failed' });
  });

  it('needs a session at all', async () => {
    const test = createAuthApp();

    const response = await request(test.app)
      .post(`/api/v1/users/${IVAN}/roles`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ roleId: ROLE });

    expect(response.status).toBe(401);
    // 401 and not 403: the guard that refuses is the one in front of the permission guard, and a
    // caller with no session has no capability to be missing.
    expect(response.body).toMatchObject({ code: 'unauthenticated' });
  });
});

describe('DELETE /api/v1/users/{userId}/roles/{roleId}', () => {
  it('removes the assignment', async () => {
    const userRoles = new FakeUserRoleRepository();

    userRoles.assignments.add(`${IVAN}:${ROLE}`);

    const { test, token } = await signedIn({
      capabilities: { isOwner: false, granted: ['role:revoke'], denied: [], permissionsVersion: 1 },
      userRoles,
    });

    await request(test.app)
      .delete(`/api/v1/users/${IVAN}/roles/${ROLE}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    expect(test.userRoles.assignments.size).toBe(0);
    expect(test.userRoles.versionBumps).toEqual([IVAN]);
  });

  /**
   * 409 rather than 403: the caller *may* do this and the subject exists — the current state is what
   * refuses, and exactly one action changes it (transfer ownership first).
   */
  it('refuses to remove the last owner', async () => {
    const userRoles = new FakeUserRoleRepository({
      role: { roleId: ROLE, key: 'owner', permissions: [] },
      ownersAfter: 0,
    });

    userRoles.assignments.add(`${IVAN}:${ROLE}`);

    const { test, token } = await signedIn({
      capabilities: { isOwner: false, granted: ['role:revoke'], denied: [], permissionsVersion: 1 },
      userRoles,
    });

    const response = await request(test.app)
      .delete(`/api/v1/users/${IVAN}/roles/${ROLE}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);

    expect(response.body).toMatchObject({
      code: 'last_owner_required',
      reason: 'last_owner_required',
    });
    expect(test.userRoles.assignments.size).toBe(1);
  });
});
