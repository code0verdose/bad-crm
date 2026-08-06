import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { FakeCustomRoleRepository } from '../../support/iam-doubles.util.js';
import { createAuthApp, type AuthApp, type AuthAppOptions } from '../../support/auth-app.util.js';

/**
 * Composing a role, as the administration screen will drive it.
 *
 * The escalation rule sits one step before assignment for a reason worth restating: a role nobody
 * holds is still a stored capability. So «create a role containing `user:impersonate`» is refused to
 * an author who does not hold it, and a role that contains something dangerous is not stored until
 * the caller has repeated the request knowing it does.
 */

const PASSWORD = 'correct-horse-battery';
const IDEMPOTENCY_KEY = 'f'.repeat(32);
/** A uuid, because the path parameter is one: the branded schema refuses anything else. */
const ROLE_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a61';

const AUTHOR = {
  isOwner: false,
  granted: ['role:create', 'role:update', 'role:delete', 'task:read'] as const,
  denied: [] as const,
  roleKeys: [] as const,
  permissionsVersion: 1,
};

const signedIn = async (
  options: AuthAppOptions = {},
): Promise<{ test: AuthApp; token: string }> => {
  const test = createAuthApp(options);

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

const author = (): AuthAppOptions => ({
  capabilities: { ...AUTHOR, granted: [...AUTHOR.granted], denied: [], roleKeys: [] },
});

describe('GET /api/v1/roles', () => {
  it('returns every role with what it grants and how many people hold it', async () => {
    const customRoles = new FakeCustomRoleRepository();

    customRoles.roles.set(ROLE_ID, {
      roleId: ROLE_ID,
      key: 'tech_writer',
      name: 'Technical writer',
      description: null,
      isSystem: false,
      permissions: ['task:read'],
    });
    customRoles.holders.set(ROLE_ID, ['ivan', 'petr']);

    const reader = {
      capabilities: {
        isOwner: false,
        granted: ['role:read'] as string[],
        denied: [] as string[],
        roleKeys: [] as string[],
        permissionsVersion: 1,
      },
      customRoles,
    } as AuthAppOptions;
    const { test, token } = await signedIn(reader);

    const response = await request(test.app)
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({
      items: [
        {
          id: ROLE_ID,
          key: 'tech_writer',
          name: 'Technical writer',
          description: null,
          isSystem: false,
          isDefault: false,
          // The count, not the names: «how many people does this change affect» is what the screen
          // asks before an edit, and who they are is a different read with a different permission.
          holderCount: 2,
          permissions: ['task:read'],
        },
      ],
    });
  });

  it('needs the capability', async () => {
    const { test, token } = await signedIn();

    const response = await request(test.app)
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
  });
});

describe('POST /api/v1/roles', () => {
  it('creates a role made of what the author holds', async () => {
    const { test, token } = await signedIn(author());

    const response = await request(test.app)
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({
        key: 'tech_writer',
        name: 'Technical writer',
        description: 'Writes the manuals',
        permissions: ['task:read'],
      })
      .expect(201);

    // The composition comes back, not only the id: a client that got an id alone could not tell a
    // composition stored whole from one narrowed on the way in — and the description is part of it,
    // so it has to survive the journey rather than being dropped on either side.
    expect(response.body).toEqual({
      id: expect.any(String),
      key: 'tech_writer',
      name: 'Technical writer',
      description: 'Writes the manuals',
      isSystem: false,
      permissions: ['task:read'],
    });
    expect(test.customRoles.roles.size).toBe(1);
    // The whole set in the trail, not the additions: «what does this role grant» has to be
    // answerable from one entry.
    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'role.created',
      after: { key: 'tech_writer', name: 'Technical writer', permissions: ['task:read'] },
    });
  });

  it('answers 409 when the key is taken, without a read-then-write race', async () => {
    // The unique index answers it. Reading first and inserting afterwards is two statements racing,
    // and the loser cannot tell its failure apart from success.
    const { test, token } = await signedIn({
      ...author(),
      customRoles: new FakeCustomRoleRepository({ duplicateKey: true }),
    });

    const response = await request(test.app)
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ key: 'tech_writer', name: 'Technical writer', permissions: ['task:read'] })
      .expect(409);

    expect(response.body).toMatchObject({ code: 'role_already_exists' });
  });

  it('refuses a role containing a permission the author lacks', async () => {
    const { test, token } = await signedIn(author());

    const response = await request(test.app)
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ key: 'shadow_admin', name: 'Shadow', permissions: ['user:impersonate'] })
      .expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
    expect(test.customRoles.roles.size).toBe(0);
  });

  /**
   * 428, and the body carries no list: which keys are dangerous is in the shared catalogue, so the
   * client already has it and can phrase the warning in its own language.
   */
  it('asks for a confirmation before storing a dangerous key', async () => {
    const dangerous = {
      capabilities: {
        isOwner: false,
        granted: ['role:create', 'task:read', 'user:impersonate'] as string[],
        denied: [] as string[],
        roleKeys: [] as string[],
        permissionsVersion: 1,
      },
    } as AuthAppOptions;
    const { test, token } = await signedIn(dangerous);

    const refused = await request(test.app)
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ key: 'support', name: 'Support', permissions: ['task:read', 'user:impersonate'] })
      .expect(428);

    expect(refused.body).toMatchObject({ code: 'confirmation_required' });
    expect(test.customRoles.roles.size).toBe(0);

    await request(test.app)
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .set('X-Confirm-Dangerous', '1')
      .send({ key: 'support', name: 'Support', permissions: ['task:read', 'user:impersonate'] })
      .expect(201);

    expect(test.customRoles.roles.size).toBe(1);
    // Two entries, and the second one is the point: severity comes from the action, so «who ever
    // stored a dangerous key» is a filter rather than a re-reading of every composition.
    expect(test.audit.events.map((event) => event.action)).toEqual([
      'organization.registered',
      'session.signed_in',
      'role.dangerous_granted',
      'role.created',
    ]);
    // The dangerous ones, not the composition: «who ever stored a dangerous key» is the question
    // this entry answers, and a full set makes the reader find them again in every row.
    expect(test.audit.events.at(-2)?.after).toEqual({ permissions: ['user:impersonate'] });
  });

  it('refuses the key of a system role, which an upgrade would overwrite', async () => {
    // Provisioning re-applies the system matrix by key on every upgrade: a custom `manager` would be
    // found by that upsert and rewritten — name, composition and all — for everybody holding it.
    const { test, token } = await signedIn(author());

    await request(test.app)
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ key: 'manager', name: 'Manager', permissions: ['task:read'] })
      .expect(422);

    expect(test.customRoles.roles.size).toBe(0);
  });

  it('stores a key repeated in the body once', async () => {
    // Not a 409 about the role key: the unique index on the grants would answer «that role already
    // exists», which is an answer about something else entirely.
    const { test, token } = await signedIn(author());

    const response = await request(test.app)
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ key: 'tech_writer', name: 'Writer', permissions: ['task:read', 'task:read'] })
      .expect(201);

    expect((response.body as { permissions: string[] }).permissions).toEqual(['task:read']);
  });

  it('refuses a key nobody declared and a key shaped like a label', async () => {
    const { test, token } = await signedIn(author());

    await request(test.app)
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ key: 'writer', name: 'Writer', permissions: ['task:teleport'] })
      .expect(422);

    await request(test.app)
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ key: 'Tech Writer', name: 'Writer', permissions: ['task:read'] })
      .expect(422);

    expect(test.customRoles.roles.size).toBe(0);
  });

  it('refuses a body that exceeds the declared limits', async () => {
    // The limits are `refine`/`max` in the schema, which v8 coverage does not see at all: without a
    // case per bound, all four could be deleted and the file would still read as fully covered.
    const { test, token } = await signedIn(author());
    const post = (body: Record<string, unknown>): request.Test =>
      request(test.app)
        .post('/api/v1/roles')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', IDEMPOTENCY_KEY)
        .send(body);

    const base = { key: 'tech_writer', name: 'Writer', permissions: [] };

    await post({ ...base, key: 'k'.repeat(65) }).expect(422);
    await post({ ...base, name: 'n'.repeat(121) }).expect(422);
    await post({ ...base, name: '   ' }).expect(422);
    await post({ ...base, description: 'd'.repeat(501) }).expect(422);
    await post({ ...base, permissions: Array.from({ length: 400 }, () => 'task:read') }).expect(
      422,
    );
    // And a field nobody declared is refused rather than ignored: silently dropping `isSystem` would
    // read to the caller as «accepted».
    await post({ ...base, isSystem: true }).expect(422);

    expect(test.customRoles.roles.size).toBe(0);
  });

  it('needs the capability', async () => {
    const { test, token } = await signedIn();

    await request(test.app)
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ key: 'tech_writer', name: 'Writer', permissions: [] })
      .expect(403);

    expect(test.customRoles.roles.size).toBe(0);
  });
});

describe('PATCH /api/v1/roles/{roleId}', () => {
  const withRole = (
    overrides: { isSystem?: boolean; holders?: string[]; elsewhere?: string[] } = {},
  ): FakeCustomRoleRepository => {
    const repository = new FakeCustomRoleRepository(
      overrides.elsewhere === undefined ? {} : { elsewhere: overrides.elsewhere },
    );

    repository.roles.set(ROLE_ID, {
      roleId: ROLE_ID,
      key: overrides.isSystem === true ? 'manager' : 'tech_writer',
      name: 'Technical writer',
      description: null,
      isSystem: overrides.isSystem ?? false,
      permissions: ['task:read'],
    });
    repository.holders.set(ROLE_ID, overrides.holders ?? []);

    return repository;
  };

  it('replaces the composition and invalidates every holder', async () => {
    const customRoles = withRole({ holders: ['ivan', 'petr'] });
    const { test, token } = await signedIn({ ...author(), customRoles });

    await request(test.app)
      .patch(`/api/v1/roles/${ROLE_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Writer', permissions: [] })
      .expect(204);

    expect(test.customRoles.roles.get(ROLE_ID)?.permissions).toEqual([]);
    // Without the bump the change would apply only at their next sign-in.
    expect(test.customRoles.versionBumps).toEqual(['ivan', 'petr']);
  });

  it('refuses to edit a system role', async () => {
    const customRoles = withRole({ isSystem: true });
    const { test, token } = await signedIn({ ...author(), customRoles });

    const response = await request(test.app)
      .patch(`/api/v1/roles/${ROLE_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Manager', permissions: [] })
      .expect(409);

    expect(response.body).toMatchObject({
      code: 'system_role_immutable',
      reason: 'system_role_immutable',
    });
  });

  it('answers 404 for a role of another organization', async () => {
    const { test, token } = await signedIn({
      ...author(),
      customRoles: new FakeCustomRoleRepository(),
    });

    const response = await request(test.app)
      .patch(`/api/v1/roles/${ROLE_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Writer', permissions: [] })
      .expect(404);

    expect(response.body).toMatchObject({ code: 'role_not_found' });
  });
});

describe('the two write capabilities are not one', () => {
  /**
   * No system role holds `role:update` without `role:delete` or the other way round, so the matrix
   * snapshot cannot see a guard that asks for the wrong one of the two — and this story is exactly
   * what makes such a role constructible, since a custom composition may contain either alone.
   */
  const onlyGranted = (
    permission: string,
    customRoles?: FakeCustomRoleRepository,
  ): AuthAppOptions =>
    ({
      capabilities: {
        isOwner: false,
        granted: [permission],
        denied: [],
        roleKeys: [],
        permissionsVersion: 1,
      },
      ...(customRoles === undefined ? {} : { customRoles }),
    }) as AuthAppOptions;

  it('refuses a deletion to somebody who may only edit', async () => {
    const { test, token } = await signedIn(onlyGranted('role:update'));

    const response = await request(test.app)
      .delete(`/api/v1/roles/${ROLE_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
  });

  it('refuses an edit to somebody who may only delete', async () => {
    const { test, token } = await signedIn(onlyGranted('role:delete'));

    const response = await request(test.app)
      .patch(`/api/v1/roles/${ROLE_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Writer', permissions: [] })
      .expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
  });
});

describe('DELETE /api/v1/roles/{roleId}', () => {
  it('removes it and invalidates everybody who held it', async () => {
    const customRoles = new FakeCustomRoleRepository();

    customRoles.roles.set(ROLE_ID, {
      roleId: ROLE_ID,
      key: 'tech_writer',
      name: 'Technical writer',
      description: null,
      isSystem: false,
      permissions: ['task:read'],
    });
    customRoles.holders.set(ROLE_ID, ['ivan']);

    const { test, token } = await signedIn({ ...author(), customRoles });

    await request(test.app)
      .delete(`/api/v1/roles/${ROLE_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    expect(test.customRoles.roles.size).toBe(0);
    expect(test.customRoles.versionBumps).toEqual(['ivan']);
  });

  it('answers 404 for a role of another organization', async () => {
    // The twin of the PATCH case, and it earns its own test rather than resting on the shared code
    // path: 403 here would answer «that role exists, elsewhere» to anybody who can guess an id.
    const { test, token } = await signedIn({
      ...author(),
      customRoles: new FakeCustomRoleRepository(),
    });

    const response = await request(test.app)
      .delete(`/api/v1/roles/${ROLE_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    expect(response.body).toMatchObject({ code: 'role_not_found' });
  });
});
