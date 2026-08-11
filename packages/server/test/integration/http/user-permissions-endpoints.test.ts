import { SharedPermissions } from '@bad-crm/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createAuthApp, type AuthApp, type AuthAppOptions } from '../../support/auth-app.util.js';

/**
 * Reading somebody else's rights, permission by permission, with the origin of each.
 *
 * The counterpart of `GET /me/permissions`, which takes no subject on purpose. What this suite is
 * about is the three things the screen of STORY-011-11 cannot render without: the answer, the layer
 * that produced it, and — whatever that layer was — what the person would fall back to if the
 * exception were lifted.
 *
 * **What this suite deliberately cannot prove.** The ports are in memory here, so the capability
 * facts arrive already folded and expiry has no meaning: «an exception past its `expiresAt` grants
 * and denies nothing» is a property of the predicate in the Prisma reader, and asserting it against
 * a double would assert the double. It is proved on a real PostgreSQL in
 * `test/integration/db/effective-permissions-attribution.test.ts`, which is also where the SQL this
 * endpoint introduced is exercised.
 */

const PASSWORD = 'correct-horse-battery'; // scan-secrets:allow gitleaks:allow — fixed test fixture, not a secret
const IDEMPOTENCY_KEY = 'd'.repeat(32);
const IVAN = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a41';
const STRANGER = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a99';
const MANAGER_ROLE = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b01';

const REGISTRATION = {
  organization: { name: 'Bad Company', slug: 'bad-company' },
  owner: { email: 'ada@example.com', password: PASSWORD },
};

/** Holds the reading key and nothing else — the capability under test, unaccompanied. */
const INSPECTOR = {
  isOwner: false,
  granted: ['permission:override_read'] as SharedPermissions.PermissionKey[],
  denied: [] as SharedPermissions.PermissionKey[],
  roleKeys: [] as string[],
  permissionsVersion: 1,
};

const GRANTED_AT = new Date('2026-08-01T10:00:00.000Z');
const EXPIRES_AT = new Date('2026-12-01T10:00:00.000Z');

const signedIn = async (
  options: AuthAppOptions = {},
): Promise<{ test: AuthApp; token: string }> => {
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

interface StateResponse {
  readonly key: string;
  readonly allowed: boolean;
  readonly source: string;
  readonly roleIds: readonly string[];
  readonly override: {
    readonly effect: string;
    readonly reason: string;
    readonly grantedById: string | null;
    readonly grantedAt: string;
    readonly expiresAt: string | null;
  } | null;
}

interface Body {
  readonly userId: string;
  readonly isOwner: boolean;
  readonly version: number;
  readonly roles: readonly {
    readonly roleId: string;
    readonly key: string;
    readonly name: string;
  }[];
  readonly permissions: readonly StateResponse[];
}

const stateOf = (body: Body, key: string): StateResponse => {
  const state = body.permissions.find((entry) => entry.key === key);

  if (state === undefined) throw new Error(`the answer says nothing about ${key}`);

  return state;
};

const read = (test: AuthApp, token: string, userId = IVAN): request.Test =>
  request(test.app)
    .get(`/api/v1/users/${userId}/permissions`)
    .set('Authorization', `Bearer ${token}`);

describe('GET /api/v1/users/{userId}/permissions', () => {
  it('answers every key of the catalogue, so «not granted» is the server’s word and not an absence', async () => {
    const { test, token } = await signedIn({
      capabilities: INSPECTOR,
      capabilitiesByUser: {
        [IVAN]: {
          isOwner: false,
          granted: ['task:read'],
          denied: [],
          roleKeys: ['developer'],
          permissionsVersion: 9,
        },
      },
    });

    const response = await read(test, token).expect(200);
    const body = response.body as Body;

    expect(body.permissions).toHaveLength(SharedPermissions.PERMISSIONS.length);
    expect(body).toMatchObject({ userId: IVAN, isOwner: false, version: 9 });
    // A key nobody granted is present and says so, rather than being left out for the client to
    // read absence as refusal — that rule would then live in the client.
    expect(stateOf(body, 'organization:delete')).toMatchObject({
      allowed: false,
      source: 'NOT_GRANTED',
      roleIds: [],
      override: null,
    });
    // The body belongs to one person and carries the sentences administrators write about them.
    expect(response.headers['cache-control']).toBe('private, no-store');
    // Express computes an `ETag` from the body by default even under `no-store`: a hash of one
    // person's exceptions would let two requests apart compare tags without reading the body, which
    // is exactly what `no-store` exists to rule out. `/me/permissions` sets its own for a different
    // reason (`me-permissions.test.ts`); this route sets none at all.
    expect(response.headers['etag']).toBeUndefined();
  });

  it('names the role behind an inherited permission', async () => {
    const { test, token } = await signedIn({
      capabilities: INSPECTOR,
      capabilitiesByUser: {
        [IVAN]: {
          isOwner: false,
          granted: ['task:read'],
          denied: [],
          roleKeys: ['manager'],
          permissionsVersion: 1,
        },
      },
      attributionByUser: {
        [IVAN]: {
          roles: [{ roleId: MANAGER_ROLE, key: 'manager', name: 'Manager' }],
          grantedByRole: { 'task:read': [MANAGER_ROLE] },
        },
      },
    });

    const body = (await read(test, token).expect(200)).body as Body;

    expect(body.roles).toEqual([{ roleId: MANAGER_ROLE, key: 'manager', name: 'Manager' }]);
    expect(stateOf(body, 'task:read')).toMatchObject({
      allowed: true,
      source: 'ROLE',
      roleIds: [MANAGER_ROLE],
      override: null,
    });
  });

  /**
   * The row the three-state control exists for, and the one that has to carry both halves: the
   * exception that refuses **and** the role that would grant it again if the exception went away.
   * A response that dropped `roleIds` here would make «inherited» a state the screen offers without
   * being able to say what it means.
   */
  it('shows a personal DENY as the refusal and still names what it overrode', async () => {
    const { test, token } = await signedIn({
      capabilities: INSPECTOR,
      capabilitiesByUser: {
        [IVAN]: {
          isOwner: false,
          granted: ['task:read'],
          denied: ['task:update'],
          roleKeys: ['manager'],
          permissionsVersion: 1,
        },
      },
      attributionByUser: {
        [IVAN]: {
          roles: [{ roleId: MANAGER_ROLE, key: 'manager', name: 'Manager' }],
          grantedByRole: { 'task:read': [MANAGER_ROLE], 'task:update': [MANAGER_ROLE] },
          overrides: {
            'task:update': {
              effect: 'DENY',
              reason: 'editing frozen during the incident review',
              grantedById: STRANGER,
              grantedAt: GRANTED_AT,
              expiresAt: EXPIRES_AT,
            },
          },
        },
      },
    });

    const body = (await read(test, token).expect(200)).body as Body;

    expect(stateOf(body, 'task:update')).toEqual({
      key: 'task:update',
      allowed: false,
      source: 'OVERRIDE_DENY',
      roleIds: [MANAGER_ROLE],
      override: {
        effect: 'DENY',
        reason: 'editing frozen during the incident review',
        grantedById: STRANGER,
        grantedAt: GRANTED_AT.toISOString(),
        expiresAt: EXPIRES_AT.toISOString(),
      },
    });
  });

  it('tells a personal ALLOW apart from a role, although both permit', async () => {
    const { test, token } = await signedIn({
      capabilities: INSPECTOR,
      capabilitiesByUser: {
        [IVAN]: {
          isOwner: false,
          granted: ['invoice:issue'],
          denied: [],
          roleKeys: [],
          permissionsVersion: 1,
        },
      },
      attributionByUser: {
        [IVAN]: {
          overrides: {
            'invoice:issue': {
              effect: 'ALLOW',
              reason: 'billing handed over during parental leave',
              grantedById: STRANGER,
              grantedAt: GRANTED_AT,
              expiresAt: null,
            },
          },
        },
      },
    });

    const body = (await read(test, token).expect(200)).body as Body;

    expect(stateOf(body, 'invoice:issue')).toMatchObject({
      allowed: true,
      source: 'OVERRIDE_ALLOW',
      // Nothing to fall back to: lifting this exception leaves the person without the permission,
      // and an empty list is how the control knows to say so.
      roleIds: [],
      override: { effect: 'ALLOW', expiresAt: null },
    });
  });

  /**
   * Row 14 of the truth table in `permission-model.md` §5: a DENY on the owner is refused by the
   * use-case and by a database trigger, and one that exists anyway is an anomaly the owner outranks.
   * The screen has to show both halves — the answer is «may», and there is a row saying otherwise —
   * because an administrator looking at this is looking for exactly that.
   */
  it('reports the owner as the source, and still surfaces a DENY row that should not exist', async () => {
    const { test, token } = await signedIn({
      capabilities: INSPECTOR,
      capabilitiesByUser: {
        [IVAN]: {
          isOwner: true,
          granted: [],
          denied: ['organization:delete'],
          roleKeys: ['owner'],
          permissionsVersion: 3,
        },
      },
      attributionByUser: {
        [IVAN]: {
          overrides: {
            'organization:delete': {
              effect: 'DENY',
              reason: 'written by a restore that predates the trigger',
              grantedById: null,
              grantedAt: GRANTED_AT,
              expiresAt: null,
            },
          },
        },
      },
    });

    const body = (await read(test, token).expect(200)).body as Body;

    expect(body.isOwner).toBe(true);
    expect(stateOf(body, 'organization:delete')).toMatchObject({
      allowed: true,
      source: 'OWNER',
      override: { effect: 'DENY', grantedById: null },
    });
  });

  it('needs a session', async () => {
    const test = createAuthApp();

    const response = await request(test.app).get(`/api/v1/users/${IVAN}/permissions`);

    expect(response.status).toBe(401);
  });

  it('refuses a caller who may read the catalogue but not a person', async () => {
    const { test, token } = await signedIn({
      // `permission:read` is the catalogue and `manager` holds it; reading who holds what is a
      // different key. Without that distinction this screen would be open to every manager.
      capabilities: { ...INSPECTOR, granted: ['permission:read', 'permission:override'] },
      capabilitiesByUser: {
        [IVAN]: {
          isOwner: false,
          granted: [],
          denied: [],
          roleKeys: [],
          permissionsVersion: 1,
        },
      },
    });

    const response = await read(test, token).expect(403);

    // `organization_forbidden`, although the request named a person: a capability refusal asks
    // whether the caller may do this *anywhere in this organization*, with no object involved
    // (`refusal-resource.util.ts`). The route guard and the query derive it from the same function,
    // so the refusal reads the same whichever of the two produced it.
    expect(response.body).toMatchObject({
      code: 'organization_forbidden',
      reason: 'permission_not_granted',
    });
  });

  it('answers 404 for a person of another organization', async () => {
    const { test, token } = await signedIn({
      capabilities: INSPECTOR,
      capabilitiesByUser: { [STRANGER]: null },
    });

    const response = await read(test, token, STRANGER).expect(404);

    expect(response.body).toMatchObject({ code: 'user_not_found' });
  });

  /**
   * The order of the two refusals, asserted as a difference that is *not* there.
   *
   * A caller without the capability is refused 403 for an id that exists and for one that does not,
   * so the endpoint answers nothing about who works here. Reverse the two checks — resolve the
   * subject first — and the same two requests answer 403 and 404, which is a membership oracle for
   * anybody holding a list of uuids.
   */
  it('refuses the same way whether or not the subject exists', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...INSPECTOR, granted: [] },
      capabilitiesByUser: {
        [IVAN]: {
          isOwner: false,
          granted: [],
          denied: [],
          roleKeys: [],
          permissionsVersion: 1,
        },
        [STRANGER]: null,
      },
    });

    const existing = await read(test, token, IVAN);
    const absent = await read(test, token, STRANGER);

    expect(existing.status).toBe(403);
    expect(absent.status).toBe(403);
    expect((absent.body as { code: string }).code).toBe((existing.body as { code: string }).code);
  });

  /**
   * The answer is the whole catalogue, and a query parameter does not narrow it.
   *
   * Asserted rather than assumed because the two plausible behaviours differ in a way a client
   * would not survive: refusing an undeclared parameter, or returning the full body. What must not
   * happen is the third — a narrowed body answering as if it were whole. This endpoint declares no
   * query schema, like every other parameterless GET in the registry, so an unknown parameter is
   * ignored and the client filters against the catalogue it already holds.
   */
  it('ignores a query parameter rather than appearing to narrow the answer', async () => {
    const { test, token } = await signedIn({
      capabilities: INSPECTOR,
      capabilitiesByUser: {
        [IVAN]: {
          isOwner: false,
          granted: ['task:read'],
          denied: [],
          roleKeys: [],
          permissionsVersion: 1,
        },
      },
    });

    const response = await read(test, token).query({ source: 'OVERRIDE_DENY' }).expect(200);

    expect((response.body as Body).permissions).toHaveLength(SharedPermissions.PERMISSIONS.length);
  });

  /**
   * `permission-model.md` §10: an ordinary `GET` is not audited, and this one is the named
   * exception — its body is the sentences an administrator wrote about a named colleague, and a run
   * of it across the roster draws the map of who administers the organization. One `permission.
   * inspected` entry per successful read, naming the reader and the person read; nothing on the
   * refusal paths, which is what the two tests above already exercise the wire for.
   */
  it('audits a successful read as permission.inspected, and only a successful read', async () => {
    const { test, token } = await signedIn({
      capabilities: INSPECTOR,
      capabilitiesByUser: {
        [IVAN]: {
          isOwner: false,
          granted: ['task:read'],
          denied: [],
          roleKeys: [],
          permissionsVersion: 1,
        },
        [STRANGER]: null,
      },
    });

    await read(test, token).expect(200);

    expect(test.audit.events).toContainEqual(
      expect.objectContaining({
        action: 'permission.inspected',
        target: { type: 'USER', id: IVAN },
      }),
    );
    expect(
      test.audit.events.filter((event) => event.action === 'permission.inspected'),
    ).toHaveLength(1);

    const refused = await read(test, token, STRANGER);

    expect(refused.status).toBe(404);
    expect(
      test.audit.events.filter((event) => event.action === 'permission.inspected'),
    ).toHaveLength(1);
  });
});
