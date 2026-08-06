import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  FakePermissionOverrideRepository,
  FakeUserRoleRepository,
} from '../../support/iam-doubles.util.js';
import { createAuthApp, type AuthApp, type AuthAppOptions } from '../../support/auth-app.util.js';

/**
 * The layer that can take a right away, as a client sees it.
 *
 * Every refusal here protects something that cannot be undone from inside the organization once it
 * happens: a DENY on the owner, a DENY on oneself over the right to manage rights, an ALLOW handing
 * out what the caller does not hold. The statuses differ on purpose — 403 «you may not», 409 «the
 * state refuses» — because the remedy differs.
 */

const PASSWORD = 'correct-horse-battery';
const IDEMPOTENCY_KEY = 'c'.repeat(32);
const IVAN = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a41';
const REASON = 'billing handed over during parental leave';

const REGISTRATION = {
  organization: { name: 'Bad Company', slug: 'bad-company' },
  owner: { email: 'ada@example.com', password: PASSWORD },
};

const ADMIN = {
  isOwner: false,
  granted: ['permission:override', 'invoice:issue'] as const,
  denied: [] as const,
  permissionsVersion: 1,
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

const url = (permission: string): string =>
  `/api/v1/users/${IVAN}/permission-overrides/${encodeURIComponent(permission)}`;

describe('PUT /api/v1/users/{userId}/permission-overrides/{permission}', () => {
  it('writes an ALLOW for a permission the caller holds, and bumps the version', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: [...ADMIN.granted], denied: [] },
      capabilitiesByUser: {
        [IVAN]: { isOwner: false, granted: [], denied: [], permissionsVersion: 1 },
      },
    });

    await request(test.app)
      .put(url('invoice:issue'))
      .set('Authorization', `Bearer ${token}`)
      .send({ effect: 'ALLOW', reason: REASON })
      .expect(204);

    expect(await test.overrides.find(IVAN, 'invoice:issue')).toMatchObject({
      effect: 'ALLOW',
      reason: REASON,
    });
    expect(test.userRoles.versionBumps).toEqual([IVAN]);
  });

  it('accepts an expiry, and accepts an explicit «until removed»', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: [...ADMIN.granted], denied: [] },
      capabilitiesByUser: {
        [IVAN]: { isOwner: false, granted: [], denied: [], permissionsVersion: 1 },
      },
    });
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await request(test.app)
      .put(url('invoice:issue'))
      .set('Authorization', `Bearer ${token}`)
      .send({ effect: 'ALLOW', reason: REASON, expiresAt })
      .expect(204);

    expect((await test.overrides.find(IVAN, 'invoice:issue'))?.expiresAt).toEqual(new Date(expiresAt));

    // `null` and «absent» mean the same thing, and a client that clears the field sends the first.
    await request(test.app)
      .put(url('invoice:issue'))
      .set('Authorization', `Bearer ${token}`)
      .send({ effect: 'ALLOW', reason: REASON, expiresAt: null })
      .expect(204);

    expect((await test.overrides.find(IVAN, 'invoice:issue'))?.expiresAt).toBeNull();
  });

  /**
   * The second write of the same pair replaces the first rather than failing: one opinion per key is
   * a property of the schema, so «somebody already decided the opposite» is the previous state to
   * record — which is what makes the trail able to answer «who changed their mind, and why».
   */
  it('replaces an existing exception instead of refusing', async () => {
    const overrides = new FakePermissionOverrideRepository();

    await overrides.upsert({
      userId: IVAN,
      permissionKey: 'invoice:issue',
      effect: 'DENY',
      reason: 'billing handed over during parental leave',
      expiresAt: null,
      grantedById: null,
    });

    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: [...ADMIN.granted], denied: [] },
      capabilitiesByUser: {
        [IVAN]: { isOwner: false, granted: [], denied: [], permissionsVersion: 1 },
      },
      overrides,
    });

    await request(test.app)
      .put(url('invoice:issue'))
      .set('Authorization', `Bearer ${token}`)
      .send({ effect: 'ALLOW', reason: 'back from leave and covering billing again' })
      .expect(204);

    expect(test.overrides.rows.size).toBe(1);
    expect(await test.overrides.find(IVAN, 'invoice:issue')).toMatchObject({ effect: 'ALLOW' });
  });

  it('refuses to hand out a permission the caller does not hold', async () => {
    const { test, token } = await signedIn({
      capabilities: { isOwner: false, granted: ['permission:override'], denied: [], permissionsVersion: 1 },
      capabilitiesByUser: {
        [IVAN]: { isOwner: false, granted: [], denied: [], permissionsVersion: 1 },
      },
    });

    const response = await request(test.app)
      .put(url('vault_item:export'))
      .set('Authorization', `Bearer ${token}`)
      .send({ effect: 'ALLOW', reason: REASON })
      .expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
    expect(test.overrides.rows.size).toBe(0);
  });

  it('allows a DENY of the same permission, because taking away is not a way to gain', async () => {
    const { test, token } = await signedIn({
      capabilities: { isOwner: false, granted: ['permission:override'], denied: [], permissionsVersion: 1 },
      capabilitiesByUser: {
        [IVAN]: { isOwner: false, granted: [], denied: [], permissionsVersion: 1 },
      },
    });

    await request(test.app)
      .put(url('vault_item:export'))
      .set('Authorization', `Bearer ${token}`)
      .send({ effect: 'DENY', reason: REASON })
      .expect(204);

    expect(test.overrides.rows.size).toBe(1);
  });

  /**
   * The rule the database repeats with a trigger: one such row makes «the owner cannot be locked
   * out» false, and an organization nobody can administer is not a state any screen can fix.
   */
  it('refuses a DENY aimed at the owner with 409', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: [...ADMIN.granted], denied: [] },
      capabilitiesByUser: {
        [IVAN]: { isOwner: true, granted: [], denied: [], permissionsVersion: 1 },
      },
    });

    const response = await request(test.app)
      .put(url('invoice:issue'))
      .set('Authorization', `Bearer ${token}`)
      .send({ effect: 'DENY', reason: REASON })
      .expect(409);

    expect(response.body).toMatchObject({
      code: 'owner_immutable',
      reason: 'owner_immutable',
    });
    expect(test.overrides.rows.size).toBe(0);
  });

  it('refuses a reason nobody could read', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: [...ADMIN.granted], denied: [] },
    });

    const response = await request(test.app)
      .put(url('invoice:issue'))
      .set('Authorization', `Bearer ${token}`)
      // Six characters. The database checks the same bound, so the two cannot drift.
      .send({ effect: 'ALLOW', reason: 'нужно' })
      .expect(422);

    expect(response.body).toMatchObject({ code: 'validation_failed' });
    expect(test.overrides.rows.size).toBe(0);
  });

  it('refuses a key nobody declared', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: [...ADMIN.granted], denied: [] },
    });

    await request(test.app)
      .put(url('invoice:teleport'))
      .set('Authorization', `Bearer ${token}`)
      .send({ effect: 'ALLOW', reason: REASON })
      .expect(422);

    expect(test.overrides.rows.size).toBe(0);
  });

  it('answers 404 for a person of another organization', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: [...ADMIN.granted], denied: [] },
      userRoles: new FakeUserRoleRepository({ knownUsers: [] }),
    });

    const response = await request(test.app)
      .put(url('invoice:issue'))
      .set('Authorization', `Bearer ${token}`)
      .send({ effect: 'ALLOW', reason: REASON })
      .expect(404);

    expect(response.body).toMatchObject({ code: 'user_not_found' });
  });

  it('needs the capability', async () => {
    const { test, token } = await signedIn();

    await request(test.app)
      .put(url('invoice:issue'))
      .set('Authorization', `Bearer ${token}`)
      .send({ effect: 'ALLOW', reason: REASON })
      .expect(403);

    expect(test.overrides.rows.size).toBe(0);
  });
});

describe('DELETE /api/v1/users/{userId}/permission-overrides/{permission}', () => {
  it('removes the exception and bumps the version', async () => {
    const overrides = new FakePermissionOverrideRepository();

    await overrides.upsert({
      userId: IVAN,
      permissionKey: 'invoice:issue',
      effect: 'DENY',
      reason: REASON,
      expiresAt: null,
      grantedById: null,
    });

    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: [...ADMIN.granted], denied: [] },
      capabilitiesByUser: {
        [IVAN]: { isOwner: false, granted: [], denied: [], permissionsVersion: 1 },
      },
      overrides,
    });

    await request(test.app)
      .delete(url('invoice:issue'))
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    expect(test.overrides.rows.size).toBe(0);
    expect(test.userRoles.versionBumps).toEqual([IVAN]);
  });

  it('answers 204 and writes nothing when there was no exception', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: [...ADMIN.granted], denied: [] },
      capabilitiesByUser: {
        [IVAN]: { isOwner: false, granted: [], denied: [], permissionsVersion: 1 },
      },
    });

    await request(test.app)
      .delete(url('invoice:issue'))
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    // The caller asked for a state and the state is there; nothing happened, so no version bump.
    expect(test.userRoles.versionBumps).toEqual([]);
  });
});
