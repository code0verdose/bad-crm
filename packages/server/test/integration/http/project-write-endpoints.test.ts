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
 * The write routes of a project over the wire — STORY-014-01, acceptance 1–9 and 11, on the mounted
 * seam: guard, validator, use-case, policy, serializer, error handler, with in-memory ports.
 *
 * Two properties this file holds that the use-case suites cannot:
 *
 * - **the four refusals are one body on a mutation, as on the read.** «Not there», «another
 *   organization's», «PRIVATE and not yours» and «deleted» reach a `PATCH` byte-for-byte alike,
 *   except for `requestId`. `project-endpoints.test.ts` proved it for the read; a mutation that
 *   answered differently would reopen the oracle on the write side;
 * - **a refused mutation leaves a row, a refused dangerous key leaves one whatever the level.**
 *   §10's two rules, seen from the wire on this domain: `POST /projects` without the key is a
 *   mutation and is filed; `DELETE` refused for the level is a `dangerous` key and is filed.
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

const ALL_PROJECT_KEYS = [
  'project:read',
  'project:create',
  'project:update',
  'project:manage_visibility',
  'project:archive',
  'project:delete',
  'project:manage_members',
] as const satisfies readonly SharedPermissions.PermissionKey[];

const holder = (granted: readonly SharedPermissions.PermissionKey[]) => ({
  isOwner: false,
  granted: [...granted],
  denied: [] as SharedPermissions.PermissionKey[],
  roleKeys: [] as string[],
  permissionsVersion: 1,
});

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
 * One project of the caller's organization, in the visibility the case asks for, with the caller
 * seated as `role` (or not at all), and three colleagues as subjects.
 */
const seeded = (
  visibility: 'PUBLIC_ORG' | 'PRIVATE' = 'PUBLIC_ORG',
  role: 'LEAD' | 'MEMBER' | 'OBSERVER' | null = 'LEAD',
): FakeProjectStore => {
  const projects = new FakeProjectStore();

  projects.seed({
    projectId: PROJECT_ID,
    organizationId: ORGANIZATION_ID,
    key: 'BAD',
    name: 'Bad CRM',
    description: 'The product itself',
    visibility,
    leadId: USER_ID,
  });

  if (role !== null) projects.addMember(PROJECT_ID, USER_ID, role);

  projects.subjects.set(USER_ID, { userId: USER_ID, status: 'ACTIVE' });
  projects.subjects.set(IVAN, { userId: IVAN, status: 'ACTIVE' });
  projects.subjects.set(PETR, { userId: PETR, status: 'ACTIVE' });
  projects.subjects.set(SUSPENDED, { userId: SUSPENDED, status: 'SUSPENDED' });

  return projects;
};

const draft = {
  key: ' ops ',
  name: 'Operations',
  leadId: IVAN,
  color: 'teal',
};

const patch = {
  name: 'Bad CRM 2',
  description: null,
  leadId: USER_ID,
  startedAt: '2026-10-01T00:00:00.000Z',
  dueAt: null,
  color: 'grape',
};

/** The trail is written on a detached promise; one turn of the event loop lets the sink see it. */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const deniedRows = (test: AuthApp) =>
  test.audit.events.filter((event) => event.action === 'access.denied');

describe('POST /api/v1/projects', () => {
  it('CONTROL: creates the project, normalizes the key, seats the creator and the lead as LEADs', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ capabilities: holder(ALL_PROJECT_KEYS), projects });

    const response = await request(test.server())
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(draft)
      .expect(201);

    // `toEqual`: the serializer is a whitelist, and a leaked `isDeleted` is what a partial match
    // would let through.
    expect(response.body).toEqual({
      id: expect.any(String),
      key: 'OPS',
      name: 'Operations',
      description: null,
      status: 'ACTIVE',
      visibility: 'PUBLIC_ORG',
      leadId: IVAN,
      color: 'teal',
      memberCount: 2,
      startedAt: null,
      dueAt: null,
      taskCounter: 0,
      createdAt: expect.any(String),
      // Every project key, and the creator's own `LEAD` seat — `MANAGER` — written in this request:
      // the block reads that seat back, so all four commands are the caller's.
      permissions: { canEdit: true, canManageMembers: true, canArchive: true, canDelete: true },
    });
    expect(projects.versionBumps).toEqual([USER_ID, IVAN]);
    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'project.created',
      target: { type: 'PROJECT', id: (response.body as { id: string }).id },
      after: { key: 'OPS', leadId: IVAN },
    });
  });

  it('answers 409 project_already_exists for a key a live project holds, in any spelling', async () => {
    const { test, token } = await signedIn({
      capabilities: holder(ALL_PROJECT_KEYS),
      projects: seeded(),
    });

    const response = await request(test.server())
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ ...draft, key: 'bad' })
      .expect(409);

    expect(response.body).toMatchObject({ code: 'project_already_exists' });
  });

  it.each([
    ['a key that is not a key after normalization', { ...draft, key: 'ba-d' }, 'key'],
    ['a key that is too long', { ...draft, key: 'ABCDEFGHIJK' }, 'key'],
    [
      'a due date before the start',
      { ...draft, startedAt: '2026-10-02T00:00:00.000Z', dueAt: '2026-10-01T00:00:00.000Z' },
      'dueAt',
    ],
    ['a colour that is a hex literal', { ...draft, color: '#ff0000' }, 'color'],
    ['an allocation-like unknown field', { ...draft, status: 'ARCHIVED' }, 'status'],
    ['an empty name', { ...draft, name: '  ' }, 'name'],
  ])('refuses %s with 422 on the field', async (_case, body, path) => {
    const { test, token } = await signedIn({
      capabilities: holder(ALL_PROJECT_KEYS),
      projects: seeded(),
    });

    const response = await request(test.server())
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(body)
      .expect(422);

    expect(response.body).toMatchObject({ code: 'validation_failed' });
    expect((response.body as { errors: { path: string }[] }).errors.map((e) => e.path)).toContain(
      path,
    );
  });

  /** Acceptance 9: a lead the tenant cannot see is 404; a suspended one 409 for a reader of the directory. */
  it('answers 404 for a foreign lead and 409 for a suspended one', async () => {
    const { test, token } = await signedIn({
      capabilities: holder([...ALL_PROJECT_KEYS, 'user:read']),
      projects: seeded(),
    });

    const foreign = await request(test.server())
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ ...draft, leadId: NOBODYS_ID })
      .expect(404);

    expect(foreign.body).toMatchObject({ code: 'user_not_found' });

    const suspended = await request(test.server())
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ ...draft, leadId: SUSPENDED })
      .expect(409);

    expect(suspended.body).toMatchObject({ code: 'member_not_active' });
  });

  /** A refused mutation is filed (§10, `mutating_request`), even on a key that is not dangerous. */
  it('refuses a caller without project:create as 403 and files access.denied', async () => {
    const { test, token } = await signedIn({
      capabilities: holder(['project:read']),
      projects: seeded(),
    });

    const response = await request(test.server())
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(draft)
      .expect(403);
    await settled();

    expect(response.body).toMatchObject({
      code: 'project_forbidden',
      reason: 'permission_not_granted',
    });
    expect(deniedRows(test)).toHaveLength(1);
    expect(deniedRows(test)[0]).toMatchObject({
      after: { permissionKey: 'project:create', because: 'mutating_request' },
    });
  });
});

describe('PATCH /api/v1/projects/{projectId}', () => {
  const edit = (test: AuthApp, token: string, projectId: string, body: object): request.Test =>
    request(test.server())
      .patch(`/api/v1/projects/${projectId}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('CONTROL: a MEMBER with project:update replaces the fields and files project.updated', async () => {
    const projects = seeded('PUBLIC_ORG', 'MEMBER');
    const { test, token } = await signedIn({ capabilities: holder(['project:update']), projects });

    await edit(test, token, PROJECT_ID, patch).expect(204);

    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'project.updated',
      target: { type: 'PROJECT', id: PROJECT_ID },
      before: { name: 'Bad CRM', color: 'indigo' },
      after: { name: 'Bad CRM 2', color: 'grape', startedAt: '2026-10-01T00:00:00.000Z' },
    });
    expect(projects.versionBumps).toEqual([]);
  });

  /** Acceptance 4: `key` is not a field of the edit, and the refusal names it. */
  it('refuses a key in the body as 422 on `key`', async () => {
    const { test, token } = await signedIn({
      capabilities: holder(['project:update']),
      projects: seeded('PUBLIC_ORG', 'MEMBER'),
    });

    const response = await edit(test, token, PROJECT_ID, { ...patch, key: 'NEW' }).expect(422);

    expect(response.body).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: 'key', code: 'unrecognized_keys' }],
    });
  });

  /** Acceptance 5: the key is held and the level is one short — 403 inside the contour. */
  it('answers 403 insufficient_acl_level to an OBSERVER', async () => {
    const { test, token } = await signedIn({
      capabilities: holder(['project:update']),
      projects: seeded('PUBLIC_ORG', 'OBSERVER'),
    });

    const response = await edit(test, token, PROJECT_ID, patch).expect(403);

    expect(response.body).toMatchObject({
      code: 'project_forbidden',
      reason: 'insufficient_acl_level',
    });
  });

  /** Acceptance 6: MANAGER on the chain and no key — refused before any port is asked. */
  it('answers 403 permission_not_granted to a LEAD without the key, reading nothing', async () => {
    const projects = seeded('PUBLIC_ORG', 'LEAD');
    const { test, token } = await signedIn({ capabilities: holder(['project:read']), projects });

    const response = await edit(test, token, PROJECT_ID, patch).expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
    expect(projects.trace).toEqual([]);
  });

  /** A changed lead needs the roster key on top; an EDITOR cannot hand MANAGER over through a rename. */
  it('refuses a lead change from an EDITOR without project:manage_members, and applies it with', async () => {
    const projects = seeded('PUBLIC_ORG', 'MEMBER');
    const { test, token } = await signedIn({ capabilities: holder(['project:update']), projects });

    const refused = await edit(test, token, PROJECT_ID, { ...patch, leadId: IVAN }).expect(403);

    expect(refused.body).toMatchObject({ reason: 'permission_not_granted' });
    expect(projects.trace).not.toContain('update');

    const lead = seeded('PUBLIC_ORG', 'LEAD');
    const manager = await signedIn({
      capabilities: holder(['project:update', 'project:manage_members']),
      projects: lead,
    });

    await edit(manager.test, manager.token, PROJECT_ID, { ...patch, leadId: IVAN }).expect(204);

    await expect(lead.membershipOf(PROJECT_ID, IVAN)).resolves.toEqual({
      projectRole: 'LEAD',
      allocationPct: 100,
    });
    expect(
      manager.test.audit.events
        .map((event) => event.action)
        .filter((action) => action.startsWith('project.')),
    ).toEqual(['project.updated', 'project.member_added']);
  });

  /**
   * `T-PROJ-02` on the third path that writes a seat's level: the caller names themselves lead.
   * Refused after the access decision — both keys held, `MANAGER` on the chain — and filed as a
   * refused mutation, exactly as the self-join on `POST …/members` is; nothing is written.
   */
  it('refuses the caller naming themselves lead as 403 self_assignment_forbidden, and files it', async () => {
    const projects = new FakeProjectStore();

    // Ivan leads today; the caller sits beside him as a second LEAD and reaches for the column.
    projects.seed({
      projectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      key: 'BAD',
      name: 'Bad CRM',
      description: 'The product itself',
      visibility: 'PUBLIC_ORG',
      leadId: IVAN,
    });
    projects.addMember(PROJECT_ID, USER_ID, 'LEAD');
    projects.addMember(PROJECT_ID, IVAN, 'LEAD');
    projects.subjects.set(USER_ID, { userId: USER_ID, status: 'ACTIVE' });
    projects.subjects.set(IVAN, { userId: IVAN, status: 'ACTIVE' });

    const { test, token } = await signedIn({
      capabilities: holder(['project:update', 'project:manage_members']),
      projects,
    });

    const response = await edit(test, token, PROJECT_ID, { ...patch, leadId: USER_ID }).expect(403);
    await settled();

    expect(response.body).toMatchObject({
      code: 'project_forbidden',
      reason: 'self_assignment_forbidden',
    });
    expect(deniedRows(test)).toHaveLength(1);
    expect(projects.trace).not.toContain('update');
    expect(projects.versionBumps).toEqual([]);
  });

  /**
   * The closed contour on a mutation, measured as bodies: four facts about the row, one answer. The
   * read proved this in `project-endpoints.test.ts`; a `PATCH` that differed would reopen the
   * oracle on the write side, where a caller could probe ids by editing them.
   */
  it('answers one 404 body for an unknown, a foreign, a PRIVATE-and-not-yours and a deleted project', async () => {
    const projects = seeded('PRIVATE', null);

    projects.seed({ projectId: OTHER_PROJECT_ID, organizationId: OTHER_ORGANIZATION_ID });
    projects.seed({ projectId: DELETED_ID, organizationId: ORGANIZATION_ID, isDeleted: true });

    const { test, token } = await signedIn({ capabilities: holder(['project:update']), projects });
    const bodies: Record<string, unknown>[] = [];

    for (const projectId of [NOBODYS_ID, OTHER_PROJECT_ID, PROJECT_ID, DELETED_ID]) {
      const response = await edit(test, token, projectId, patch).expect(404);
      const { requestId, ...body } = response.body as Record<string, unknown>;

      expect(requestId).toEqual(expect.any(String));
      bodies.push(body);
    }

    expect(bodies[0]).toMatchObject({ status: 404, code: 'project_not_found' });
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(projects.trace).not.toContain('update');
    expect(test.audit.events.filter((event) => event.action === 'project.updated')).toEqual([]);
  });

  it('refuses an id that is not a uuid with 422, not 500', async () => {
    const { test, token } = await signedIn({
      capabilities: holder(['project:update']),
      projects: seeded(),
    });

    const response = await edit(test, token, 'BAD', patch).expect(422);

    expect(response.body).toMatchObject({ code: 'validation_failed' });
  });
});

describe('POST /api/v1/projects/{projectId}/visibility', () => {
  const change = (
    test: AuthApp,
    token: string,
    visibility: string,
    confirmed: boolean,
  ): request.Test => {
    const call = request(test.server())
      .post(`/api/v1/projects/${PROJECT_ID}/visibility`)
      .set('Authorization', `Bearer ${token}`);

    return (confirmed ? call.set('X-Confirm-Dangerous', '1') : call).send({ visibility });
  };

  /** Acceptance 7: confirmed, the change lands and is filed loud. */
  it('CONTROL: a LEAD with the key and the header makes the project PRIVATE', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({
      capabilities: holder(['project:manage_visibility']),
      projects,
    });

    await change(test, token, 'PRIVATE', true).expect(204);

    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'project.visibility_changed',
      before: { visibility: 'PUBLIC_ORG' },
      after: { visibility: 'PRIVATE' },
    });
  });

  it('answers 428 confirmation_required without the header, and changes nothing', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({
      capabilities: holder(['project:manage_visibility']),
      projects,
    });

    const response = await change(test, token, 'PRIVATE', false).expect(428);

    expect(response.body).toMatchObject({ code: 'confirmation_required' });
    expect(projects.trace).not.toContain('changeVisibility');
  });

  /** A caller who may not change it is refused by the key — without the header, and without a 428. */
  it('answers 403, not 428, to a caller without the key who sent no header', async () => {
    const { test, token } = await signedIn({
      capabilities: holder(['project:read']),
      projects: seeded(),
    });

    const response = await change(test, token, 'PRIVATE', false).expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
  });

  it('is idempotent on the visibility already held, and asks for no confirmation', async () => {
    const { test, token } = await signedIn({
      capabilities: holder(['project:manage_visibility']),
      projects: seeded(),
    });

    await change(test, token, 'PUBLIC_ORG', false).expect(204);

    expect(
      test.audit.events.filter((event) => event.action === 'project.visibility_changed'),
    ).toEqual([]);
  });

  /** A dangerous key refused for the level is filed whatever the method (§10, `dangerous_permission`). */
  it('refuses a MEMBER holding the key as 403 insufficient_acl_level, and files it as a dangerous refusal', async () => {
    const { test, token } = await signedIn({
      capabilities: holder(['project:manage_visibility']),
      projects: seeded('PUBLIC_ORG', 'MEMBER'),
    });

    const response = await change(test, token, 'PRIVATE', true).expect(403);
    await settled();

    expect(response.body).toMatchObject({ reason: 'insufficient_acl_level' });
    expect(deniedRows(test)[0]).toMatchObject({
      after: { permissionKey: 'project:manage_visibility', because: 'dangerous_permission' },
    });
  });
});

describe('POST /api/v1/projects/{projectId}/archive and DELETE /api/v1/projects/{projectId}', () => {
  it('CONTROL: archives once, files once, and a repeat is a silent 204', async () => {
    const { test, token } = await signedIn({
      capabilities: holder(['project:archive']),
      projects: seeded(),
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await request(test.server())
        .post(`/api/v1/projects/${PROJECT_ID}/archive`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
    }

    expect(test.audit.events.filter((event) => event.action === 'project.archived')).toEqual([
      expect.objectContaining({ before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' } }),
    ]);
  });

  it('deletes softly: the project answers 404 afterwards with the body an unknown id gets, every member bumped', async () => {
    const projects = seeded();

    projects.addMember(PROJECT_ID, IVAN, 'MEMBER');

    const { test, token } = await signedIn({
      capabilities: holder(['project:delete', 'project:read']),
      projects,
    });

    await request(test.server())
      .delete(`/api/v1/projects/${PROJECT_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    expect(projects.versionBumps).toEqual([USER_ID, IVAN]);
    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'project.deleted',
      before: {
        key: 'BAD',
        members: [
          { userId: USER_ID, projectRole: 'LEAD' },
          { userId: IVAN, projectRole: 'MEMBER' },
        ],
      },
    });

    const bodies = await Promise.all(
      [PROJECT_ID, NOBODYS_ID].map(async (projectId) => {
        const response = await request(test.server())
          .get(`/api/v1/projects/${projectId}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(404);
        const { requestId, ...body } = response.body as Record<string, unknown>;

        expect(requestId).toEqual(expect.any(String));

        return body;
      }),
    );

    expect(bodies[0]).toEqual(bodies[1]);
  });

  /** Refused for the level on a dangerous key: filed, with the key named (positive control for the trail). */
  it('refuses a MEMBER holding project:delete as 403, files it, and deletes nothing', async () => {
    const projects = seeded('PUBLIC_ORG', 'MEMBER');
    const { test, token } = await signedIn({ capabilities: holder(['project:delete']), projects });

    const response = await request(test.server())
      .delete(`/api/v1/projects/${PROJECT_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    await settled();

    expect(response.body).toMatchObject({ reason: 'insufficient_acl_level' });
    expect(projects.trace).not.toContain('softDelete');
    expect(deniedRows(test)[0]).toMatchObject({
      after: { permissionKey: 'project:delete', because: 'dangerous_permission' },
    });
  });

  it('answers 404 for a deleted project on archive and on delete alike', async () => {
    const projects = seeded();

    projects.seed({ projectId: DELETED_ID, organizationId: ORGANIZATION_ID, isDeleted: true });

    const { test, token } = await signedIn({
      capabilities: holder(['project:archive', 'project:delete']),
      projects,
    });

    const archived = await request(test.server())
      .post(`/api/v1/projects/${DELETED_ID}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    const deleted = await request(test.server())
      .delete(`/api/v1/projects/${DELETED_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    expect(archived.body).toMatchObject({ code: 'project_not_found' });
    expect(deleted.body).toMatchObject({ code: 'project_not_found' });
  });
});
