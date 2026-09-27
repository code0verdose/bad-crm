import { type SharedPermissions } from '@bad-crm/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { recordableDenial } from '@/domain/access/denied-access-audit.policy.js';

import { createAuthApp, type AuthApp, type AuthAppOptions } from '../../support/auth-app.util.js';
import {
  ORGANIZATION_ID,
  OTHER_ORGANIZATION_ID,
  USER_ID,
} from '../../support/identity-doubles.util.js';
import { FakeProjectStore } from '../../support/project-doubles.util.js';

/**
 * The first `project:*` route over the wire — STORY-014-05, the server half of the project card,
 * and with it the resource halves of STORY-011-07 (acceptance 3 and 4) on a mounted route.
 *
 * What is measured here is the **seam**: guard, validator, use-case, policy, serializer, error
 * handler — over the real HTTP surface and in-memory ports. Whether the statements those ports would
 * send are right is `test/integration/db/project-read-access.test.ts` (three indistinguishable 404s
 * on a live PostgreSQL); the order the ports are asked in is `get-project-detail.query.test.ts`.
 *
 * Two properties this file holds that neither of those can:
 *
 * - **the four refusals are one body.** «Not there», «another organization's», «PRIVATE and not
 *   yours» and «deleted» reach the caller byte-for-byte alike, except for `requestId`. Comparing the
 *   bodies rather than the codes is the point: a `detail` string that differed would be the oracle
 *   invariant 2 forbids, with the same code on every branch;
 * - **the refusal leaves no row.** `project:read` is not `dangerous` and `GET` changes nothing, so
 *   §10 of the permission model says a refusal here is a counter and never an entry
 *   (`denied-access-audit.policy.ts`). The negative is stated beside a positive control on the same
 *   harness — a refused mutation that *does* leave one — so «no row» is the rule and not a sink
 *   nobody wired.
 */

const PASSWORD = 'correct-horse-battery';
const IDEMPOTENCY_KEY = 'e'.repeat(32);
const PROJECT_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b01';
const OTHER_PROJECT_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b02';
const UNKNOWN_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b09';

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

/** A store with one project of the caller's organization, in the visibility the case asks for. */
const seeded = (visibility: 'PUBLIC_ORG' | 'PRIVATE' = 'PUBLIC_ORG'): FakeProjectStore => {
  const projects = new FakeProjectStore();

  projects.seed({
    projectId: PROJECT_ID,
    organizationId: ORGANIZATION_ID,
    key: 'BAD',
    name: 'Bad CRM',
    description: 'The product itself',
    visibility,
    leadId: USER_ID,
    startedAt: new Date('2026-09-01T00:00:00.000Z'),
    dueAt: null,
    taskCounter: 14,
  });

  return projects;
};

const readProject = (test: AuthApp, token: string, projectId: string): request.Test =>
  request(test.server())
    .get(`/api/v1/projects/${projectId}`)
    .set('Authorization', `Bearer ${token}`);

/**
 * The trail is written on a detached promise (`bestEffortDeniedAccessAudit`): the refused caller
 * waits on nothing. One turn of the event loop is enough for the in-memory sink, and the positive
 * control below proves that it is.
 */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('GET /api/v1/projects/{projectId}', () => {
  it('CONTROL: a member of the organization reads a PUBLIC_ORG project, whitelisted field by field', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ capabilities: READER, projects });

    const response = await readProject(test, token, PROJECT_ID).expect(200);

    // `toEqual`, not `toMatchObject`: the serializer is a whitelist, and a field that leaked —
    // `isDeleted`, an `organizationId` — is exactly what a partial match would let through.
    expect(response.body).toEqual({
      id: PROJECT_ID,
      key: 'BAD',
      name: 'Bad CRM',
      description: 'The product itself',
      status: 'ACTIVE',
      visibility: 'PUBLIC_ORG',
      leadId: USER_ID,
      color: 'indigo',
      memberCount: 0,
      startedAt: '2026-09-01T00:00:00.000Z',
      dueAt: null,
      taskCounter: 14,
      createdAt: '2026-09-06T12:00:00.000Z',
      // A bystander of a `PUBLIC_ORG` project holding only `project:read`: `VIEWER` on the chain
      // and no write key — every button of the card is absent.
      permissions: {
        canEdit: false,
        canManageMembers: false,
        canChangeVisibility: false,
        canArchive: false,
        canDelete: false,
      },
    });
    // The capability was decided before a statement was sent, then the scope and the chain, and the
    // entity last — the order STORY-011-07 acceptance 4 asks for, seen from the wire.
    expect(projects.trace).toEqual(['scope', 'aclFacts', 'entriesAlong', 'detail']);
  });

  it('reads a PRIVATE project for somebody who is on it', async () => {
    const projects = seeded('PRIVATE');

    projects.addMember(PROJECT_ID, USER_ID, 'OBSERVER');

    const { test, token } = await signedIn({ capabilities: READER, projects });

    const response = await readProject(test, token, PROJECT_ID).expect(200);

    expect(response.body).toMatchObject({ id: PROJECT_ID, visibility: 'PRIVATE', memberCount: 1 });
  });

  /**
   * The `permissions` block on the wire (STORY-014-05, acceptance 5): the same keys, two seats, two
   * different blocks. A `MEMBER` is `EDITOR` — the card may offer «edit» and nothing that needs
   * `MANAGER`; a `LEAD` is `MANAGER` and is offered all five. Which command each flag stands for is
   * `project-card-permissions.test.ts`; here it is the shape the client reads, over the whole seam.
   */
  it.each([
    [
      'MEMBER',
      {
        canEdit: true,
        canManageMembers: false,
        canChangeVisibility: false,
        canArchive: false,
        canDelete: false,
      },
    ] as const,
    [
      'LEAD',
      {
        canEdit: true,
        canManageMembers: true,
        canChangeVisibility: true,
        canArchive: true,
        canDelete: true,
      },
    ] as const,
  ])('answers the block a %s is owed, decided by the server', async (seat, expected) => {
    const projects = seeded();

    projects.addMember(PROJECT_ID, USER_ID, seat);

    const { test, token } = await signedIn({
      capabilities: {
        ...READER,
        granted: [
          'project:read',
          'project:update',
          'project:manage_members',
          'project:manage_visibility',
          'project:archive',
          'project:delete',
        ],
      },
      projects,
    });

    const response = await readProject(test, token, PROJECT_ID).expect(200);

    expect((response.body as { permissions: unknown }).permissions).toEqual(expected);
    // Five decisions over the facts the read already held: the trace is the control's, not longer.
    expect(projects.trace).toEqual(['scope', 'aclFacts', 'entriesAlong', 'detail']);
  });

  /**
   * The closed contour, measured as bodies. Four different facts about the row, one answer — and
   * the answer to «is there a project with this id in this organization» must not be readable off
   * any of them.
   */
  it('answers one 404 body for an unknown, a foreign, a PRIVATE-and-not-yours and a deleted project', async () => {
    const projects = seeded('PRIVATE');

    projects.seed({ projectId: OTHER_PROJECT_ID, organizationId: OTHER_ORGANIZATION_ID });
    projects.seed({ projectId: UNKNOWN_ID, organizationId: ORGANIZATION_ID, isDeleted: true });

    const { test, token } = await signedIn({ capabilities: READER, projects });

    const bodies: Record<string, unknown>[] = [];

    // One after another: the fake unit of work holds a single open scope, and the store reads the
    // tenant from it — two requests in flight would read each other's.
    for (const projectId of [
      '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5bff', // nobody's
      OTHER_PROJECT_ID, // another organization's
      PROJECT_ID, // PRIVATE, and the caller is not on it
      UNKNOWN_ID, // deleted
    ]) {
      const response = await readProject(test, token, projectId).expect(404);
      const { requestId, ...body } = response.body as Record<string, unknown>;

      expect(requestId).toEqual(expect.any(String));
      bodies.push(body);
    }

    expect(bodies[0]).toMatchObject({ status: 404, code: 'project_not_found' });
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    // And the entity was never read for any of them.
    expect(projects.trace).not.toContain('detail');
  });

  /**
   * An id that is not a uuid is refused at the boundary as `422`, the way every parameterised route
   * of this API refuses one (`teamIdParamsSchema`, `roleIdParamsSchema`). Without the validator the
   * cast `${projectId}::uuid` in `scope()` would raise on PostgreSQL and the caller would be told
   * `500` — a retry invitation for something that can never succeed.
   */
  it('refuses an id that is not a uuid with 422, not 500', async () => {
    const { test, token } = await signedIn({ capabilities: READER, projects: seeded() });

    const response = await readProject(test, token, 'BAD').expect(422);

    expect(response.body).toMatchObject({ code: 'validation_failed' });
  });

  /** Acceptance 3 of STORY-011-07: no key, no statement — inside one's own organization that is 403. */
  it('answers 403 permission_not_granted without project:read, before any port is asked', async () => {
    const projects = seeded();
    const { test, token } = await signedIn({ projects });

    const response = await readProject(test, token, PROJECT_ID).expect(403);

    expect(response.body).toMatchObject({
      code: 'project_forbidden',
      reason: 'permission_not_granted',
    });
    expect(projects.trace).toEqual([]);
  });

  /** Rule 9 of `rules/permissions.mdc`: the owner is `MANAGER` on the root without a walk, and holds no key. */
  it('lets the owner read a PRIVATE project they are not on, with no key at all', async () => {
    const projects = seeded('PRIVATE');
    const { test, token } = await signedIn({
      capabilities: { ...READER, isOwner: true, granted: [] },
      projects,
    });

    const response = await readProject(test, token, PROJECT_ID).expect(200);

    expect(response.body).toMatchObject({ id: PROJECT_ID, visibility: 'PRIVATE' });
  });

  /** `unavailable` from the resolver is «we could not check», and that is 503 — not a level. */
  it('answers 503 when the chain cannot be read, and does not read the entity', async () => {
    const projects = seeded();

    projects.aclFailure = new Error('connection reset');

    const { test, token } = await signedIn({ capabilities: READER, projects });

    const response = await readProject(test, token, PROJECT_ID).expect(503);

    expect(response.body).toMatchObject({
      code: 'service_unavailable',
      reason: 'acl_resolution_failed',
    });
    expect(projects.trace).not.toContain('detail');
  });

  describe('the refusal trail', () => {
    /**
     * The positive control, on the same harness and the same sink: a refused **mutation** files
     * `access.denied`. Without it the case after this one would pass against a harness whose trail
     * is not wired at all.
     */
    it('CONTROL: a refused mutation on this harness does leave an access.denied row', async () => {
      const { test, token } = await signedIn({ projects: seeded() });

      await request(test.server())
        .post('/api/v1/teams')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', IDEMPOTENCY_KEY)
        .send({ name: 'Backend', slug: 'backend' })
        .expect(403);
      await settled();

      expect(test.audit.events.filter((event) => event.action === 'access.denied')).toHaveLength(1);
      // The rule as a value: the same refusal, on a mutating method, is an entry.
      expect(
        recordableDenial({
          reason: 'permission_not_granted',
          permissionKey: 'project:read',
          method: 'POST',
        }),
      ).toEqual({ reason: 'permission_not_granted', because: 'mutating_request' });
    });

    it('leaves no row for a refused read: project:read is not dangerous and GET changes nothing', async () => {
      const projects = seeded('PRIVATE');
      const { test, token } = await signedIn({ projects });

      await readProject(test, token, PROJECT_ID).expect(403);
      await settled();

      const { test: reader, token: readerToken } = await signedIn({
        capabilities: READER,
        projects,
      });

      await readProject(reader, readerToken, PROJECT_ID).expect(404);
      await settled();

      expect(test.audit.events.filter((event) => event.action === 'access.denied')).toEqual([]);
      expect(reader.audit.events.filter((event) => event.action === 'access.denied')).toEqual([]);
      expect(
        recordableDenial({
          reason: 'permission_not_granted',
          permissionKey: 'project:read',
          method: 'GET',
        }),
      ).toBeNull();
    });
  });
});
