import { type SharedPermissions } from '@bad-crm/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  APP_URL,
  createAuthApp,
  type AuthApp,
  type AuthAppOptions,
} from '../../support/auth-app.util.js';
import { USER_ID, authUser } from '../../support/identity-doubles.util.js';

/**
 * Offboarding over HTTP.
 *
 * The property this level exists for is the **report**: an offboarding whose answer carries no
 * counters is one the caller has to trust rather than check, and the story exists to replace «кажется,
 * всё отключили» with a list of what was actually revoked. The other half is the honesty of that
 * list — steps no subsystem exists for yet are **named as pending**, never counted as zero, because
 * «revoked 0 secure links» claims we looked.
 *
 * Two things this file asserts and no other level can. **Sessions really end**, which is criterion 3
 * of the story and the one property the whole operation exists for: a subject holding a live session
 * is offboarded here and their refresh token stops working in the same test, so `sessionsRevoked`
 * cannot quietly become a constant. And **the trail is written**, with the counters the answer
 * carried — a reviewer asking «was that offboarding complete» must be able to read it from the log
 * rather than take the API response on faith.
 */

const IDEMPOTENCY_KEY = 'f'.repeat(32);
const SECOND_KEY = 'a'.repeat(32);
const PASSWORD = 'correct-horse-battery';
const OWNER = 'ada@example.com';
const COLLEAGUE = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5ae1';
const COLLEAGUE_EMAIL = 'grace@example.com';
const STRANGER = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5ae9';

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

/**
 * A colleague of this organization, with the team memberships a suspension will remove.
 *
 * `teams` is a count for the cases that only care how many, and the memberships it stands for carry
 * a role: `LEAD` and `MEMBER` are what disappears with the rows, and what somebody re-granting them
 * afterwards has to read out of the trail.
 */
const seedColleague = (test: AuthApp, ownerId: string, teams = 0): void => {
  test.userLifecycle.rows.set(COLLEAGUE, {
    userId: COLLEAGUE,
    status: 'ACTIVE',
    organizationOwnerId: ownerId,
  });
  test.userLifecycle.teams.set(
    COLLEAGUE,
    Array.from({ length: teams }, (_unused, index) => ({
      teamId: `018f4a3b-0000-7000-8000-00000000ea0${index}`,
      teamRole: index === 0 ? 'LEAD' : 'MEMBER',
    })),
  );
};

const deactivate = (test: AuthApp, token: string, userId: string, key = IDEMPOTENCY_KEY) =>
  request(test.app)
    .post(`/api/v1/users/${userId}/deactivate`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send({ reason: 'left the company' });

const reactivate = (test: AuthApp, token: string, userId: string, key = IDEMPOTENCY_KEY) =>
  request(test.app)
    .post(`/api/v1/users/${userId}/reactivate`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send({});

interface Report {
  readonly userId: string;
  readonly alreadyDeactivated: boolean;
  readonly sessionsRevoked: number;
  readonly teamsLeft: number;
  readonly pending: string[];
}

describe('POST /api/v1/users/{userId}/deactivate', () => {
  it('CONTROL: switches the account off and reports what that removed', async () => {
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:suspend']),
    });

    seedColleague(test, userId, 3);

    const body = (await deactivate(test, token, COLLEAGUE).expect(200)).body as Report;

    expect(body).toMatchObject({
      userId: COLLEAGUE,
      alreadyDeactivated: false,
      teamsLeft: 3,
    });
    expect(test.userLifecycle.rows.get(COLLEAGUE)?.status).toBe('SUSPENDED');
  });

  it('names the steps this installation cannot take, instead of counting them as zero', async () => {
    // The difference the story is about: «revoked 0 secure links» claims we looked. Each of these
    // disappears when its subsystem lands — projects with EPIC-014, sockets with M5, links and vault
    // with M7 — and until then the report says so out loud.
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:suspend']),
    });

    seedColleague(test, userId);

    const body = (await deactivate(test, token, COLLEAGUE).expect(200)).body as Report;

    expect(body.pending).toEqual([
      'projectsLeft',
      'socketsClosed',
      'linksRevoked',
      'vaultMembershipsFlagged',
    ]);
    expect(body).not.toHaveProperty('linksRevoked');
  });

  it('files the trail entry, carrying the same counters the answer carried', async () => {
    // A reviewer asking «was that offboarding complete» must be able to read the answer out of the
    // log rather than take the API response on faith. Without this assertion the `audit.record` call
    // could be deleted outright and the suite would stay green.
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:suspend']),
    });

    seedColleague(test, userId, 2);

    const body = (await deactivate(test, token, COLLEAGUE).expect(200)).body as Report;

    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'user.suspended',
      target: { type: 'USER', id: COLLEAGUE },
      before: { status: 'ACTIVE' },
      after: {
        status: 'SUSPENDED',
        reason: 'left the company',
        sessionsRevoked: body.sessionsRevoked,
        teamsLeft: 2,
      },
    });
  });

  it('records which teams the person was in, and in what role, because the rows do not survive', async () => {
    // `team_members` is deleted outright — there is no `deleted_at` on it — and `team_role` goes
    // with the row. A counter alone leaves whoever re-grants the memberships tomorrow with no source
    // for *what* to grant, and nothing to recover from short of a database restore.
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:suspend']),
    });

    seedColleague(test, userId, 2);
    await deactivate(test, token, COLLEAGUE).expect(200);

    expect((test.audit.events.at(-1)?.after as { teams: unknown }).teams).toEqual([
      { teamId: '018f4a3b-0000-7000-8000-00000000ea00', teamRole: 'LEAD' },
      { teamId: '018f4a3b-0000-7000-8000-00000000ea01', teamRole: 'MEMBER' },
    ]);
  });

  it('is idempotent: the second run writes nothing and says so', async () => {
    // Offboarding is often run twice, by two people. The second run must not read in the trail as a
    // second event, and must not claim to have revoked anything again.
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:suspend']),
    });

    seedColleague(test, userId, 2);

    await deactivate(test, token, COLLEAGUE).expect(200);

    const second = (await deactivate(test, token, COLLEAGUE, SECOND_KEY).expect(200))
      .body as Report;

    expect(second).toMatchObject({ alreadyDeactivated: true, teamsLeft: 0, sessionsRevoked: 0 });
    expect(test.userLifecycle.suspended).toHaveLength(1);
  });

  it('refuses to deactivate the caller’s own account', async () => {
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:suspend']),
    });

    test.userLifecycle.rows.set(userId, {
      userId,
      status: 'ACTIVE',
      organizationOwnerId: userId,
    });

    const response = await deactivate(test, token, userId).expect(409);

    expect((response.body as { code: string }).code).toBe('self_lockout');
    expect(test.userLifecycle.suspended).toEqual([]);
  });

  it('refuses to deactivate the owner until ownership is transferred', async () => {
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:suspend']),
    });

    // The colleague *is* the owner: the organization would be left with nobody able to administer it.
    test.userLifecycle.rows.set(COLLEAGUE, {
      userId: COLLEAGUE,
      status: 'ACTIVE',
      organizationOwnerId: COLLEAGUE,
    });
    expect(String(userId)).not.toBe(COLLEAGUE);

    const response = await deactivate(test, token, COLLEAGUE).expect(409);

    expect((response.body as { code: string }).code).toBe('last_owner_required');
    expect(test.userLifecycle.suspended).toEqual([]);
  });

  it('answers 404 for somebody of another organization, not 403', async () => {
    // Otherwise the endpoint is an oracle for which accounts exist elsewhere in the installation.
    const { test, token } = await signedIn({ capabilities: capabilities(['user:suspend']) });

    const response = await deactivate(test, token, STRANGER).expect(404);

    expect((response.body as { code: string }).code).toBe('user_not_found');
  });

  it('refuses somebody without user:suspend', async () => {
    const { test, token, userId } = await signedIn({ capabilities: capabilities([]) });

    seedColleague(test, userId);

    const response = await deactivate(test, token, COLLEAGUE).expect(403);

    expect((response.body as { reason: string }).reason).toBe('permission_not_granted');
  });

  it('refuses to switch off somebody whose permissions the caller does not hold', async () => {
    // `T-IAM-09`, the rule every other way of touching somebody's rights already carries. Without
    // it one holder of `user:suspend` can walk the directory and end every other administrator's
    // session — and only the owner can undo it.
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:suspend']),
      capabilitiesByUser: {
        [COLLEAGUE]: {
          isOwner: false,
          granted: ['role:update'],
          denied: [],
          roleKeys: ['admin'],
          permissionsVersion: 1,
        },
      },
    });

    seedColleague(test, userId, 3);

    const response = await deactivate(test, token, COLLEAGUE).expect(403);

    expect((response.body as { reason: string }).reason).toBe('permission_not_granted');
    expect(test.userLifecycle.suspended).toEqual([]);
    expect(test.userLifecycle.rows.get(COLLEAGUE)?.status).toBe('ACTIVE');
  });

  it('answers 404, not a crash, when the account vanishes between the two reads', async () => {
    // The subset rule needs a second read, and two reads are two snapshots: an account soft-deleted
    // by a concurrent transaction is found by the first and gone from the second. Fail-closed and
    // fail-quiet — the same 404 as any other id this caller may not see, never «permissions of
    // undefined» and never a suspension decided on a set nobody could read.
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:suspend']),
      capabilitiesByUser: { [COLLEAGUE]: null },
    });

    seedColleague(test, userId, 1);

    const response = await deactivate(test, token, COLLEAGUE).expect(404);

    expect((response.body as { code: string }).code).toBe('user_not_found');
    expect(test.userLifecycle.suspended).toEqual([]);
  });

  it('CONTROL: the same subject goes through once the caller holds that permission too', async () => {
    // The positive control the refusal above needs: without it the test would also pass on a policy
    // that refuses everybody, and the rule would look enforced while being a wall.
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:suspend', 'role:update']),
      capabilitiesByUser: {
        [COLLEAGUE]: {
          isOwner: false,
          granted: ['role:update'],
          denied: [],
          roleKeys: ['admin'],
          permissionsVersion: 1,
        },
      },
    });

    seedColleague(test, userId, 3);

    const body = (await deactivate(test, token, COLLEAGUE).expect(200)).body as Report;

    expect(body).toMatchObject({ alreadyDeactivated: false, teamsLeft: 3 });
  });

  it('requires a reason, because «switched off, no reason given» costs an hour later', async () => {
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:suspend']),
    });

    seedColleague(test, userId);

    const response = await request(test.app)
      .post(`/api/v1/users/${COLLEAGUE}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({})
      .expect(422);

    expect((response.body as { code: string }).code).toBe('validation_failed');
  });
});

describe('POST /api/v1/users/{userId}/reactivate', () => {
  it('brings the account back and states that memberships did not come with it', async () => {
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:suspend', 'user:reactivate']),
    });

    seedColleague(test, userId, 2);
    await deactivate(test, token, COLLEAGUE).expect(200);

    const body = (await reactivate(test, token, COLLEAGUE, SECOND_KEY).expect(200)).body as {
      alreadyActive: boolean;
      membershipsRestored: boolean;
    };

    // Stated in the answer rather than left to a release note: somebody returning to the same job
    // gets their teams back by being added to them, by a person who decided so today.
    expect(body).toMatchObject({ alreadyActive: false, membershipsRestored: false });
    expect(test.userLifecycle.teams.get(COLLEAGUE)).toEqual([]);
  });

  it('files the trail entry, saying what did not come back with the account', async () => {
    // Without this assertion the whole `audit.record` call could be deleted and the suite would stay
    // green — and «who switched this account back on, and when» is exactly the question the trail is
    // kept for.
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:suspend', 'user:reactivate']),
    });

    seedColleague(test, userId, 1);
    await deactivate(test, token, COLLEAGUE).expect(200);
    await reactivate(test, token, COLLEAGUE, SECOND_KEY).expect(200);

    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'user.reactivated',
      target: { type: 'USER', id: COLLEAGUE },
      before: { status: 'SUSPENDED' },
      after: { status: 'ACTIVE', membershipsRestored: false },
    });
  });

  it('is idempotent on an account that was never off', async () => {
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:reactivate']),
    });

    seedColleague(test, userId);

    const body = (await reactivate(test, token, COLLEAGUE).expect(200)).body as {
      alreadyActive: boolean;
    };

    expect(body.alreadyActive).toBe(true);
    expect(test.userLifecycle.reactivated).toEqual([]);
  });

  it('needs its own capability, which user:suspend does not include', async () => {
    // Bringing an account back is the step an intruder needs after an offboarding, and an
    // organization may well let more people switch somebody off than switch them on.
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:suspend']),
    });

    seedColleague(test, userId);

    const response = await reactivate(test, token, COLLEAGUE).expect(403);

    expect((response.body as { reason: string }).reason).toBe('permission_not_granted');
    expect(test.userLifecycle.reactivated).toEqual([]);
  });

  it('refuses to bring back somebody whose permissions the caller does not hold', async () => {
    // `T-IAM-09`, mirrored on the way back in. Without it, a single holder of `user:reactivate`
    // could walk the directory and restore any suspended account — including one that outranks
    // them, and one that was suspended during an incident precisely because it did
    // (`packages/shared/src/audit/audit-severity.enums.ts`: «an account coming back is the step an
    // intruder needs after an offboarding»).
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:reactivate']),
      capabilitiesByUser: {
        [COLLEAGUE]: {
          isOwner: false,
          granted: ['role:update'],
          denied: [],
          roleKeys: ['admin'],
          permissionsVersion: 1,
        },
      },
    });

    test.userLifecycle.rows.set(COLLEAGUE, {
      userId: COLLEAGUE,
      status: 'SUSPENDED',
      organizationOwnerId: userId,
    });

    const response = await reactivate(test, token, COLLEAGUE).expect(403);

    expect((response.body as { reason: string }).reason).toBe('permission_not_granted');
    expect(test.userLifecycle.reactivated).toEqual([]);
    expect(test.userLifecycle.rows.get(COLLEAGUE)?.status).toBe('SUSPENDED');
  });

  it('CONTROL: the same subject comes back once the caller holds that permission too', async () => {
    // The positive control the refusal above needs: without it the test would also pass on a
    // policy that refuses everybody, and the rule would look enforced while being a wall.
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:reactivate', 'role:update']),
      capabilitiesByUser: {
        [COLLEAGUE]: {
          isOwner: false,
          granted: ['role:update'],
          denied: [],
          roleKeys: ['admin'],
          permissionsVersion: 1,
        },
      },
    });

    test.userLifecycle.rows.set(COLLEAGUE, {
      userId: COLLEAGUE,
      status: 'SUSPENDED',
      organizationOwnerId: userId,
    });

    const body = (await reactivate(test, token, COLLEAGUE).expect(200)).body as {
      alreadyActive: boolean;
    };

    expect(body.alreadyActive).toBe(false);
    expect(test.userLifecycle.rows.get(COLLEAGUE)?.status).toBe('ACTIVE');
  });

  it('answers 404, not a crash, when the account vanishes between the two reads', async () => {
    // The subset rule needs a second read, and two reads are two snapshots: an account soft-deleted
    // by a concurrent transaction is found by the first and gone from the second. Fail-closed and
    // fail-quiet — the same 404 as any other id this caller may not see, never a reactivation
    // decided on a permission set nobody could read.
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['user:reactivate']),
      capabilitiesByUser: { [COLLEAGUE]: null },
    });

    test.userLifecycle.rows.set(COLLEAGUE, {
      userId: COLLEAGUE,
      status: 'SUSPENDED',
      organizationOwnerId: userId,
    });

    const response = await reactivate(test, token, COLLEAGUE).expect(404);

    expect((response.body as { code: string }).code).toBe('user_not_found');
    expect(test.userLifecycle.reactivated).toEqual([]);
  });
});

/**
 * Criterion 3 of the story, at the only level that can show it.
 *
 * Every other suite offboards somebody who never had a session, so `sessionsRevoked` is honestly `0`
 * there — and a `revokeAllFamilies` call replaced by the literal `0` would pass all of them. Here the
 * subject signs in first, which makes the number observable and the reason (`OFFBOARDING`) readable,
 * and then the credential that outlives an access token — the refresh cookie — is presented again.
 * A token minted a minute ago and valid for fourteen more has to stop working on the next request
 * rather than at expiry (`T-IAM-06`).
 */
describe('ending the sessions of the person being offboarded', () => {
  const cookieOf = (response: { headers: Record<string, unknown> }): string => {
    const header = response.headers['set-cookie'];
    const cookies = Array.isArray(header) ? (header as string[]) : [];

    return cookies.find((cookie) => cookie.startsWith('bad_crm_refresh='))?.split(';')[0] ?? '';
  };

  /** The administrator and the colleague, both signed in for real, in the same organization. */
  const bothSignedIn = async (): Promise<{
    test: AuthApp;
    adminToken: string;
    colleagueCookie: string;
  }> => {
    const test = createAuthApp({
      accounts: [authUser(), authUser({ userId: COLLEAGUE, email: COLLEAGUE_EMAIL })],
      capabilities: capabilities(['user:suspend']),
    });

    const admin = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: OWNER, password: PASSWORD })
      .expect(200);
    const colleague = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: COLLEAGUE_EMAIL, password: PASSWORD })
      .expect(200);

    test.userLifecycle.rows.set(COLLEAGUE, {
      userId: COLLEAGUE,
      status: 'ACTIVE',
      organizationOwnerId: USER_ID,
    });

    return {
      test,
      adminToken: (admin.body as { accessToken: string }).accessToken,
      colleagueCookie: cookieOf(colleague),
    };
  };

  it('reports a non-zero count and revokes with reason OFFBOARDING', async () => {
    const { test, adminToken, colleagueCookie } = await bothSignedIn();

    expect(colleagueCookie).not.toBe('');

    const body = (await deactivate(test, adminToken, COLLEAGUE).expect(200)).body as Report;

    expect(body.sessionsRevoked).toBeGreaterThan(0);
    // The reason, not only the fact: the trail has to say an offboarding ended these sessions rather
    // than the person signing out, and `OFFBOARDING` appears nowhere else in the product.
    const colleagueSessions = [...test.sessions.rows.values()].filter(
      (row) => row.userId === COLLEAGUE,
    );

    expect(colleagueSessions).not.toHaveLength(0);
    expect(colleagueSessions.every((row) => row.revokedReason === 'OFFBOARDING')).toBe(true);
  });

  it('CONTROL: the refresh cookie works before the offboarding and not after it', async () => {
    const { test, adminToken, colleagueCookie } = await bothSignedIn();

    // The positive control. Without it, a cookie that never worked — a wrong `Origin`, a misspelt
    // name — would make the 401 below prove nothing at all.
    const before = await request(test.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', colleagueCookie)
      .set('Origin', APP_URL)
      .expect(200);

    await deactivate(test, adminToken, COLLEAGUE).expect(200);

    const after = await request(test.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieOf(before))
      .set('Origin', APP_URL)
      .expect(401);

    expect((after.body as { code: string }).code).toBe('unauthenticated');
  });
});
