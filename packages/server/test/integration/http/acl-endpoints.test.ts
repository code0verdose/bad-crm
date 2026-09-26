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
 * The grant routes over the wire — STORY-011-06, acceptance 1 and 11 at the HTTP seam, and the
 * route half of STORY-012-07 (a team as the subject of a grant), with in-memory ports.
 *
 * The caller's own level on the project comes from the store's roster and visibility through the
 * real resolver: `LEAD` is `MANAGER`, `MEMBER` is `EDITOR`, a bystander of a `PUBLIC_ORG` project
 * is `VIEWER` and of a `PRIVATE` one `NONE`. What the wire adds to the use-case suites: the
 * validator's refusals, the capability guard in front, the idempotency key on the write, the
 * problem bodies — and the one property only a route can show, that every outsider of a
 * revocation reads the same `404 acl_not_found` body whatever the id was.
 */

const PASSWORD = 'correct-horse-battery';
const IDEMPOTENCY_KEY = 'f'.repeat(32);
const PROJECT_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b01';
const OTHER_PROJECT_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b02';
const FOREIGN_PROJECT_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b03';
const NOBODYS_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5bff';
const IVAN = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b11';
const PETR = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b12';
const TEAM = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b21';
const FOREIGN_TEAM = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b22';

const holder = (granted: readonly SharedPermissions.PermissionKey[]) => ({
  isOwner: false,
  granted: [...granted],
  denied: [] as SharedPermissions.PermissionKey[],
  roleKeys: [] as string[],
  permissionsVersion: 1,
});

const MANAGER = holder(['acl:read', 'acl:grant', 'acl:revoke']);

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

const project = { type: 'PROJECT' as const, id: PROJECT_ID };

/**
 * The caller on the project with the given role (or not on it), Ivan and Petr as accounts, a team
 * of two, and a neighbour project beside it — so a list that answered the organization's grants
 * rather than the object's, or a revocation that took the object's grants rather than one, shows.
 */
const seeded = (
  visibility: 'PUBLIC_ORG' | 'PRIVATE' = 'PUBLIC_ORG',
  callerRole: 'LEAD' | 'MEMBER' | null = 'LEAD',
): FakeProjectStore => {
  const projects = new FakeProjectStore();

  projects.seed({ projectId: PROJECT_ID, organizationId: ORGANIZATION_ID, visibility });
  projects.seed({ projectId: OTHER_PROJECT_ID, organizationId: ORGANIZATION_ID });
  projects.seed({ projectId: FOREIGN_PROJECT_ID, organizationId: OTHER_ORGANIZATION_ID });

  if (callerRole !== null) projects.addMember(PROJECT_ID, USER_ID, callerRole);
  projects.addMember(OTHER_PROJECT_ID, USER_ID, 'LEAD');

  projects.subjects.set(USER_ID, { userId: USER_ID, status: 'ACTIVE' });
  projects.subjects.set(IVAN, { userId: IVAN, status: 'ACTIVE' });
  projects.subjects.set(PETR, { userId: PETR, status: 'ACTIVE' });
  projects.aclSubjects.set(`TEAM:${TEAM}`, [IVAN, PETR]);

  return projects;
};

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const list = (test: AuthApp, token: string, query: string): request.Test =>
  request(test.server()).get(`/api/v1/acl${query}`).set('Authorization', `Bearer ${token}`);

const grant = (test: AuthApp, token: string, body: object): request.Test =>
  request(test.server())
    .post('/api/v1/acl')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', IDEMPOTENCY_KEY)
    .send(body);

const revoke = (test: AuthApp, token: string, aclId: string): request.Test =>
  request(test.server()).delete(`/api/v1/acl/${aclId}`).set('Authorization', `Bearer ${token}`);

const teamEditor = {
  resourceType: 'PROJECT',
  resourceId: PROJECT_ID,
  subjectType: 'TEAM',
  subjectId: TEAM,
  accessLevel: 'EDITOR',
  expiresAt: null,
};

describe('GET /api/v1/acl', () => {
  it('CONTROL: lists the live grants of this project and of nothing else, whitelisted field by field', async () => {
    const projects = seeded();
    const team = projects.seedGrant({
      organizationId: ORGANIZATION_ID,
      resource: project,
      subject: { type: 'TEAM', id: TEAM },
      level: 'EDITOR',
      expiresAt: null,
      grantedById: PETR,
    });

    // Three rows that must not appear: an expired grant here, a grant on the neighbour, a grant
    // of another organization on this very id.
    projects.seedGrant({
      organizationId: ORGANIZATION_ID,
      resource: project,
      subject: { type: 'USER', id: IVAN },
      level: 'VIEWER',
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      grantedById: PETR,
    });
    projects.seedGrant({
      organizationId: ORGANIZATION_ID,
      resource: { type: 'PROJECT', id: OTHER_PROJECT_ID },
      subject: { type: 'USER', id: PETR },
      level: 'MANAGER',
      expiresAt: null,
      grantedById: USER_ID,
    });
    projects.seedGrant({
      organizationId: OTHER_ORGANIZATION_ID,
      resource: project,
      subject: { type: 'USER', id: PETR },
      level: 'MANAGER',
      expiresAt: null,
      grantedById: null,
    });

    const { test, token } = await signedIn({ capabilities: holder(['acl:read']), projects });
    const response = await list(
      test,
      token,
      `?resourceType=PROJECT&resourceId=${PROJECT_ID}`,
    ).expect(200);

    expect(response.body).toEqual({
      items: [
        {
          id: team,
          resourceType: 'PROJECT',
          resourceId: PROJECT_ID,
          subjectType: 'TEAM',
          subjectId: TEAM,
          accessLevel: 'EDITOR',
          expiresAt: null,
          grantedById: PETR,
          grantedAt: '2026-09-06T12:00:00.000Z',
        },
      ],
    });
  });

  it('answers a PRIVATE project the caller is not on, and another organization’s, as 404 project_not_found', async () => {
    const projects = seeded('PRIVATE', null);
    const { test, token } = await signedIn({ capabilities: holder(['acl:read']), projects });

    for (const projectId of [PROJECT_ID, FOREIGN_PROJECT_ID, NOBODYS_ID]) {
      const response = await list(
        test,
        token,
        `?resourceType=PROJECT&resourceId=${projectId}`,
      ).expect(404);

      expect(response.body).toMatchObject({ code: 'project_not_found' });
    }
    expect(projects.trace).not.toContain('acl.listOn');
  });

  it('refuses a caller without acl:read with 403 before any port is asked', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ projects });

    const response = await list(
      test,
      token,
      `?resourceType=PROJECT&resourceId=${PROJECT_ID}`,
    ).expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
    expect(projects.trace).toEqual([]);
  });

  it('refuses a kind no chain resolves, a malformed id and a missing parameter with 422', async () => {
    const { test, token } = await signedIn({
      capabilities: holder(['acl:read']),
      projects: seeded(),
    });

    for (const query of [
      `?resourceType=BOARD&resourceId=${PROJECT_ID}`,
      '?resourceType=PROJECT&resourceId=not-a-uuid',
      '?resourceType=PROJECT',
    ]) {
      const response = await list(test, token, query).expect(422);

      expect(response.body).toMatchObject({ code: 'validation_failed' });
    }
  });
});

describe('POST /api/v1/acl', () => {
  /** Acceptance 1 of STORY-011-06, and acceptance 3 of STORY-012-07: the row, the bump of every member, the entry. */
  it('CONTROL: a LEAD grants a team EDITOR, bumps both members, files acl.granted, and the list shows it', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });

    const response = await grant(test, token, teamEditor).expect(200);
    const { id } = response.body as { id: string };

    expect(response.body).toEqual({ id: expect.any(String) });
    expect(projects.grants).toEqual([
      expect.objectContaining({
        id,
        organizationId: ORGANIZATION_ID,
        resource: project,
        subject: { type: 'TEAM', id: TEAM },
        level: 'EDITOR',
        expiresAt: null,
        grantedById: USER_ID,
      }),
    ]);
    expect(projects.versionBumps).toEqual([IVAN, PETR]);
    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'acl.granted',
      target: { type: 'RESOURCE_ACL', id },
      after: { resourceType: 'PROJECT', subjectType: 'TEAM', accessLevel: 'EDITOR' },
    });
    expect(test.audit.events.at(-1)?.actor.ipAddress).toBeDefined();

    const listed = await list(test, token, `?resourceType=PROJECT&resourceId=${PROJECT_ID}`).expect(
      200,
    );

    expect((listed.body as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([id]);
  });

  it('carries an expiry through to the row as an instant', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });

    await grant(test, token, { ...teamEditor, expiresAt: '2026-12-31T00:00:00.000Z' }).expect(200);

    expect(projects.grants[0]?.expiresAt).toEqual(new Date('2026-12-31T00:00:00.000Z'));
  });

  /** Acceptance 11: EDITOR on the project does not hand anything out. */
  it('refuses a MEMBER (EDITOR on the project) as 403 insufficient_acl_level and writes nothing', async () => {
    const projects = seeded('PUBLIC_ORG', 'MEMBER');
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });

    const response = await grant(test, token, { ...teamEditor, accessLevel: 'MANAGER' }).expect(
      403,
    );

    expect(response.body).toMatchObject({
      code: 'project_forbidden',
      reason: 'insufficient_acl_level',
    });
    expect(projects.grants).toEqual([]);
    expect(projects.versionBumps).toEqual([]);
  });

  it('answers a PRIVATE project the caller is not on, and another organization’s, as 404 project_not_found', async () => {
    const projects = seeded('PRIVATE', null);
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });

    for (const resourceId of [PROJECT_ID, FOREIGN_PROJECT_ID]) {
      const response = await grant(test, token, { ...teamEditor, resourceId }).expect(404);

      expect(response.body).toMatchObject({ code: 'project_not_found' });
    }
    expect(projects.trace).not.toContain('acl.subjectExists');
    expect(projects.grants).toEqual([]);
  });

  it('answers a team that is not here as 404 team_not_found, in the subject’s own words', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });

    const response = await grant(test, token, { ...teamEditor, subjectId: FOREIGN_TEAM }).expect(
      404,
    );

    expect(response.body).toMatchObject({ code: 'team_not_found' });
    expect(projects.grants).toEqual([]);
  });

  it('refuses NONE on the caller’s own entry as 409 self_lockout', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });

    const response = await grant(test, token, {
      ...teamEditor,
      subjectType: 'USER',
      subjectId: USER_ID,
      accessLevel: 'NONE',
    }).expect(409);

    expect(response.body).toMatchObject({ code: 'self_lockout', reason: 'self_lockout' });
    expect(projects.grants).toEqual([]);
  });

  it('refuses a caller without acl:grant with 403 before any port is asked', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ capabilities: holder(['acl:read']), projects });

    const response = await grant(test, token, teamEditor).expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
    expect(projects.trace).toEqual([]);
  });

  it('refuses an unknown level, a kind no chain resolves and a field the contract does not name with 422', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });

    for (const body of [
      { ...teamEditor, accessLevel: 'OWNER' },
      { ...teamEditor, resourceType: 'VAULT' },
      { ...teamEditor, organizationId: OTHER_ORGANIZATION_ID },
    ]) {
      const response = await grant(test, token, body).expect(422);

      expect(response.body).toMatchObject({ code: 'validation_failed' });
    }
    expect(projects.grants).toEqual([]);
  });

  it('demands an Idempotency-Key', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });

    const response = await request(test.server())
      .post('/api/v1/acl')
      .set('Authorization', `Bearer ${token}`)
      .send(teamEditor);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(projects.grants).toEqual([]);
  });
});

describe('DELETE /api/v1/acl/{aclId}', () => {
  const seedTwo = (projects: FakeProjectStore): { team: string; neighbour: string } => ({
    team: projects.seedGrant({
      organizationId: ORGANIZATION_ID,
      resource: project,
      subject: { type: 'TEAM', id: TEAM },
      level: 'EDITOR',
      expiresAt: null,
      grantedById: PETR,
    }),
    neighbour: projects.seedGrant({
      organizationId: ORGANIZATION_ID,
      resource: project,
      subject: { type: 'USER', id: IVAN },
      level: 'VIEWER',
      expiresAt: null,
      grantedById: PETR,
    }),
  });

  it('CONTROL: a LEAD revokes one grant, bumps whom it reached, files acl.revoked — the neighbour stays', async () => {
    const projects = seeded();
    const { team, neighbour } = seedTwo(projects);
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });

    await revoke(test, token, team).expect(204);

    expect(projects.grants.map((row) => row.id)).toEqual([neighbour]);
    expect(projects.versionBumps).toEqual([IVAN, PETR]);
    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'acl.revoked',
      target: { type: 'RESOURCE_ACL', id: team },
      before: { subjectType: 'TEAM', subjectId: TEAM, accessLevel: 'EDITOR' },
    });
  });

  /**
   * The oracle this route could have been: four facts about an id, one body. An unknown id, another
   * organization's grant, and a grant on a `PRIVATE` project the caller is not on — each would be
   * a different code if the refusal were coded on the object.
   */
  it('answers one 404 acl_not_found body for an unknown id, another organization’s grant and a grant the caller cannot see', async () => {
    const projects = seeded('PRIVATE', null);
    const { team } = seedTwo(projects);
    const foreign = projects.seedGrant({
      organizationId: OTHER_ORGANIZATION_ID,
      resource: { type: 'PROJECT', id: FOREIGN_PROJECT_ID },
      subject: { type: 'USER', id: PETR },
      level: 'MANAGER',
      expiresAt: null,
      grantedById: null,
    });
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });
    const bodies: Record<string, unknown>[] = [];

    for (const aclId of [NOBODYS_ID, foreign, team]) {
      const response = await revoke(test, token, aclId).expect(404);
      const { requestId, ...body } = response.body as Record<string, unknown>;

      expect(requestId).toEqual(expect.any(String));
      bodies.push(body);
    }

    expect(bodies[0]).toMatchObject({ status: 404, code: 'acl_not_found' });
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(projects.grants).toHaveLength(3);
    expect(test.audit.events.filter((event) => event.action === 'acl.revoked')).toEqual([]);
  });

  it('refuses a caller who sees the project with EDITOR as 403 acl_forbidden, removing nothing', async () => {
    const projects = seeded('PUBLIC_ORG', 'MEMBER');
    const { team } = seedTwo(projects);
    const { test, token } = await signedIn({ capabilities: MANAGER, projects });

    const response = await revoke(test, token, team).expect(403);
    await settled();

    expect(response.body).toMatchObject({
      code: 'acl_forbidden',
      reason: 'insufficient_acl_level',
    });
    expect(projects.grants).toHaveLength(2);
  });

  it('refuses a caller without acl:revoke with 403 before the grant is read', async () => {
    const projects = seeded();
    const { team } = seedTwo(projects);
    const { test, token } = await signedIn({ capabilities: holder(['acl:read']), projects });

    const response = await revoke(test, token, team).expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
    expect(projects.trace).toEqual([]);
  });

  it('refuses an id that is not a uuid with 422, not 500', async () => {
    const { test, token } = await signedIn({ capabilities: MANAGER, projects: seeded() });

    const response = await revoke(test, token, 'not-a-uuid').expect(422);

    expect(response.body).toMatchObject({ code: 'validation_failed' });
  });
});
