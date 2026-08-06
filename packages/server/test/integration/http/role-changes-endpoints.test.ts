import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { FakeCustomRoleRepository } from '../../support/iam-doubles.util.js';
import { createAuthApp, type AuthApp, type AuthAppOptions } from '../../support/auth-app.util.js';

/**
 * The two endpoints the administration matrix drives: «what would this do» and «do it».
 *
 * The pair exists because the screen edits several roles at once, and the two questions the client
 * cannot answer for itself are how many people a change reaches and whether the server would accept
 * it. Both are answered by the same policy over the same read, so the summary shown before the save
 * and the outcome of the save cannot disagree.
 */

const PASSWORD = 'correct-horse-battery';
const IDEMPOTENCY_KEY = 'a'.repeat(32);
const WRITERS = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a61';
const AUDITORS = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a62';

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

const twoRoles = (): FakeCustomRoleRepository => {
  const repository = new FakeCustomRoleRepository();

  repository.roles.set(WRITERS, {
    roleId: WRITERS,
    key: 'tech_writer',
    name: 'Technical writer',
    description: null,
    isSystem: false,
    permissions: ['task:read'],
  });
  repository.roles.set(AUDITORS, {
    roleId: AUDITORS,
    key: 'auditor',
    name: 'Auditor',
    description: null,
    isSystem: false,
    permissions: ['task:read'],
  });
  repository.holders.set(WRITERS, ['ivan', 'petr']);
  repository.holders.set(AUDITORS, ['petr']);

  return repository;
};

const editor = (customRoles: FakeCustomRoleRepository): AuthAppOptions =>
  ({
    capabilities: {
      isOwner: false,
      granted: ['role:read', 'role:update', 'task:read', 'task:update', 'user:impersonate'],
      denied: [],
      roleKeys: [],
      permissionsVersion: 1,
    },
    customRoles,
  }) as AuthAppOptions;

const DRAFT = {
  changes: [
    { roleId: WRITERS, permissions: ['task:read', 'task:update'] },
    { roleId: AUDITORS, permissions: [] },
  ],
};

describe('POST /api/v1/roles/preview-changes', () => {
  it('answers what each change does, for how many people, and whether it would be accepted', async () => {
    const customRoles = twoRoles();
    const { test, token } = await signedIn(editor(customRoles));

    const response = await request(test.app)
      .post('/api/v1/roles/preview-changes')
      .set('Authorization', `Bearer ${token}`)
      .send(DRAFT)
      .expect(200);

    expect(response.body).toEqual({
      items: [
        {
          roleId: WRITERS,
          key: 'tech_writer',
          name: 'Technical writer',
          isSystem: false,
          holderCount: 2,
          added: ['task:update'],
          removed: [],
          dangerous: [],
          reason: null,
        },
        {
          roleId: AUDITORS,
          key: 'auditor',
          name: 'Auditor',
          isSystem: false,
          holderCount: 1,
          added: [],
          removed: ['task:read'],
          dangerous: [],
          reason: null,
        },
      ],
    });
    // A preview writes nothing.
    expect(test.customRoles.roles.get(WRITERS)?.permissions).toEqual(['task:read']);
  });

  it('is open to somebody who may read roles but not edit them', async () => {
    // The summary is for the people who look at the matrix, and looking is `role:read`.
    const customRoles = twoRoles();
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
      .post('/api/v1/roles/preview-changes')
      .set('Authorization', `Bearer ${token}`)
      .send({ changes: [{ roleId: WRITERS, permissions: [] }] })
      .expect(200);

    // And it tells them the truth: they may look, so every change reads «you could not save this».
    // A verdict of `null` here would offer a Save the server refuses a second later.
    expect(response.body).toMatchObject({
      items: [{ removed: ['task:read'], reason: 'permission_not_granted' }],
    });
    expect(test.customRoles.roles.get(WRITERS)?.permissions).toEqual(['task:read']);
  });

  it('refuses a draft that is empty, oversized, or repeats a key inside one role', async () => {
    // The three bounds of the schema, none of which any other case reaches: an empty draft is a
    // request that means nothing, sixty-five roles is the ceiling that keeps one transaction
    // finishable, and a key repeated inside a role would hit the unique index and answer 500.
    const { test, token } = await signedIn(editor(twoRoles()));
    const post = (body: object): request.Test =>
      request(test.app)
        .post('/api/v1/roles/preview-changes')
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    await post({ changes: [] }).expect(422);
    await post({
      changes: Array.from({ length: 65 }, (_unused, index) => ({
        roleId: `018f4a3b-2c1d-7a41-9f00-2b7c1d0e${String(index).padStart(4, '0')}`,
        permissions: [],
      })),
    }).expect(422);

    // A repeated key inside one role is **not** an error: the schema folds it, because the caller
    // meant one grant and the unique index would have answered with a 500 about something else.
    const folded = await post({
      changes: [{ roleId: WRITERS, permissions: ['task:read', 'task:read'] }],
    }).expect(200);

    expect((folded.body as { items: { removed: string[] }[] }).items[0]?.removed).toEqual([]);
  });

  it('refuses a draft naming the same role twice', async () => {
    // «What should this role grant» would have two answers, and picking either silently is how a
    // screen and a database stop agreeing.
    const { test, token } = await signedIn(editor(twoRoles()));

    const response = await request(test.app)
      .post('/api/v1/roles/preview-changes')
      .set('Authorization', `Bearer ${token}`)
      .send({
        changes: [
          { roleId: WRITERS, permissions: [] },
          { roleId: WRITERS, permissions: ['task:read'] },
        ],
      })
      .expect(422);

    expect(response.body).toMatchObject({ code: 'validation_failed' });
  });
});

describe('POST /api/v1/roles/apply-changes', () => {
  const apply = (test: AuthApp, token: string, body: object = DRAFT): request.Test =>
    request(test.app)
      .post('/api/v1/roles/apply-changes')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(body);

  it('applies the whole draft in one request', async () => {
    const customRoles = twoRoles();
    const { test, token } = await signedIn(editor(customRoles));

    await apply(test, token).expect(204);

    expect(test.customRoles.roles.get(WRITERS)?.permissions).toEqual(['task:read', 'task:update']);
    expect(test.customRoles.roles.get(AUDITORS)?.permissions).toEqual([]);
    // Everybody holding a role that moved, once per role.
    expect(test.customRoles.versionBumps).toEqual(['ivan', 'petr', 'petr']);
  });

  it('applies nothing when one change is refused', async () => {
    const customRoles = twoRoles();

    customRoles.roles.set(AUDITORS, {
      roleId: AUDITORS,
      key: 'manager',
      name: 'Manager',
      description: null,
      isSystem: true,
      permissions: ['task:read'],
    });

    const { test, token } = await signedIn(editor(customRoles));
    const response = await apply(test, token).expect(409);

    expect(response.body).toMatchObject({ code: 'system_role_immutable' });
    expect(test.customRoles.roles.get(WRITERS)?.permissions).toEqual(['task:read']);
    expect(test.customRoles.versionBumps).toEqual([]);
  });

  it('asks for a confirmation once for a draft carrying a dangerous key', async () => {
    const customRoles = twoRoles();
    const { test, token } = await signedIn(editor(customRoles));
    const dangerous = {
      changes: [{ roleId: WRITERS, permissions: ['task:read', 'user:impersonate'] }],
    };

    const refused = await apply(test, token, dangerous).expect(428);

    expect(refused.body).toMatchObject({ code: 'confirmation_required' });
    expect(test.customRoles.roles.get(WRITERS)?.permissions).toEqual(['task:read']);

    await request(test.app)
      .post('/api/v1/roles/apply-changes')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .set('X-Confirm-Dangerous', '1')
      .send(dangerous)
      .expect(204);

    expect(test.customRoles.roles.get(WRITERS)?.permissions).toEqual([
      'task:read',
      'user:impersonate',
    ]);
  });

  it('answers 404 for a role of another organization', async () => {
    const { test, token } = await signedIn(editor(new FakeCustomRoleRepository()));

    const response = await apply(test, token, {
      changes: [{ roleId: WRITERS, permissions: [] }],
    }).expect(404);

    expect(response.body).toMatchObject({ code: 'role_not_found' });
  });

  it('needs the editing right, which reading the preview does not grant', async () => {
    const reader = {
      capabilities: {
        isOwner: false,
        granted: ['role:read'] as string[],
        denied: [] as string[],
        roleKeys: [] as string[],
        permissionsVersion: 1,
      },
      customRoles: twoRoles(),
    } as AuthAppOptions;
    const { test, token } = await signedIn(reader);

    const response = await apply(test, token).expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
  });
});
