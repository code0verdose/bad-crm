import { type SharedPermissions } from '@bad-crm/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  APP_URL,
  createAuthApp,
  type AuthApp,
  type AuthAppOptions,
} from '../../support/auth-app.util.js';
import { authUser } from '../../support/identity-doubles.util.js';

/**
 * Administrative 2FA reset over HTTP: `POST /api/v1/users/{userId}/reset-mfa` (STORY-013-04,
 * acceptance 5, 6, 7, 9).
 *
 * What only this level can show: that the route sits behind `user:reset_mfa` rather than merely
 * being reachable by an authenticated caller, and that **sessions really end** — the same property
 * `user-lifecycle.test.ts` exists to prove for offboarding, proven here the identical way: the
 * subject signs in for real, the reset runs, and the refresh cookie minted before it stops working
 * on the next request rather than at its own expiry (`T-IAM-06`).
 */

const IDEMPOTENCY_KEY = 'e'.repeat(32);
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

const cookieOf = (response: { headers: Record<string, unknown> }): string => {
  const header = response.headers['set-cookie'];
  const cookies = Array.isArray(header) ? (header as string[]) : [];

  return cookies.find((cookie) => cookie.startsWith('bad_crm_refresh='))?.split(';')[0] ?? '';
};

/** The administrator and the colleague, both signed in for real, in the same organization. */
const bothSignedIn = async (
  options: Pick<AuthAppOptions, 'capabilities' | 'capabilitiesByUser' | 'rateLimit'> = {},
): Promise<{ test: AuthApp; adminToken: string; colleagueCookie: string }> => {
  const test = createAuthApp({
    accounts: [authUser(), authUser({ userId: COLLEAGUE, email: COLLEAGUE_EMAIL })],
    capabilities: options.capabilities ?? capabilities(['user:reset_mfa']),
    ...(options.capabilitiesByUser === undefined
      ? {}
      : { capabilitiesByUser: options.capabilitiesByUser }),
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
  });

  const admin = await request(test.server())
    .post('/api/v1/auth/login')
    .send({ email: OWNER, password: PASSWORD })
    .expect(200);
  const colleague = await request(test.server())
    .post('/api/v1/auth/login')
    .send({ email: COLLEAGUE_EMAIL, password: PASSWORD })
    .expect(200);

  return {
    test,
    adminToken: (admin.body as { accessToken: string }).accessToken,
    colleagueCookie: cookieOf(colleague),
  };
};

const enableTotp = async (test: AuthApp, userId: string): Promise<void> => {
  await test.enrollment.beginDraft(
    userId,
    'enc:secret',
    new Date(test.clock.now().getTime() + 60_000),
  );
  await test.enrollment.commitEnrollment(userId, 1, test.clock.now());
  test.recoveryCodeRows.rows.set(`${userId}-code-1`, {
    id: `${userId}-code-1`,
    userId,
    codeHash: 'hash',
    usedAt: null,
  });
};

const resetMfa = (test: AuthApp, token: string, userId: string, key = IDEMPOTENCY_KEY) =>
  request(test.server())
    .post(`/api/v1/users/${userId}/reset-mfa`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key);

interface ResetResult {
  readonly userId: string;
  readonly wasEnabled: boolean;
  readonly recoveryCodesDeleted: number;
  readonly sessionsRevoked: number;
}

describe('POST /api/v1/users/{userId}/reset-mfa', () => {
  it('CONTROL: clears the enrolment and deletes every recovery code, reporting counts', async () => {
    const { test, adminToken } = await bothSignedIn();

    await enableTotp(test, COLLEAGUE);

    const response = await resetMfa(test, adminToken, COLLEAGUE).expect(200);
    const body = response.body as ResetResult;

    expect(body.wasEnabled).toBe(true);
    expect(body.recoveryCodesDeleted).toBe(1);

    const state = await test.enrollment.find(COLLEAGUE);

    expect(state).toBeNull();
  });

  it('MEDIUM-2: is a true no-op on an account with no 2FA — no session revoked, no mail sent', async () => {
    const { test, adminToken, colleagueCookie } = await bothSignedIn();

    expect(colleagueCookie).not.toBe('');

    const response = await resetMfa(test, adminToken, COLLEAGUE).expect(200);
    const body = response.body as ResetResult;

    expect(body.wasEnabled).toBe(false);
    expect(body.sessionsRevoked).toBe(0);
    expect(body.recoveryCodesDeleted).toBe(0);
    expect(test.dispatcher.dispatched).toEqual([]);

    // LOW-2: a true no-op still writes the trail entry — the whole point being that an attempt
    // against an account with no 2FA is not free to make and leave no row behind. What a true no-op
    // must not do is touch anything else (asserted below and by the positive control that follows).
    const entry = test.audit.events.find((event) => event.action === 'user.mfa_reset_by_admin');

    expect(entry).toMatchObject({
      before: { totpEnabled: false },
      after: { totpEnabled: false, recoveryCodesDeleted: 0, sessionsRevoked: 0 },
    });
    // LOW-1: the CRITICAL-severity entry carries the caller's address, the same source
    // `clientOf(request)` reads for every session-opening flow — never left `undefined`.
    expect(entry?.actor.ipAddress).toBeDefined();

    // The positive control: the colleague's session, opened during sign-in, is still live — a repeat
    // that changed nothing must not have touched it.
    const after = await request(test.server())
      .post('/api/v1/auth/refresh')
      .set('Cookie', colleagueCookie)
      .set('Origin', APP_URL)
      .expect(200);

    expect(after.status).toBe(200);
  });

  it('MEDIUM-2: a loop against an account with no 2FA never revokes a session opened afterwards', async () => {
    const { test, adminToken } = await bothSignedIn({
      rateLimit: { limits: { mfa_admin_reset_attempt: 100 } },
    });

    await resetMfa(test, adminToken, COLLEAGUE, 'a'.repeat(32)).expect(200);
    await resetMfa(test, adminToken, COLLEAGUE, 'b'.repeat(32)).expect(200);
    await resetMfa(test, adminToken, COLLEAGUE, 'c'.repeat(32)).expect(200);

    expect(test.dispatcher.dispatched).toEqual([]);
    expect(test.userRoles.versionBumps).toEqual([]);
  });

  it('refuses without the permission — 403 user_forbidden', async () => {
    const { test, adminToken } = await bothSignedIn({ capabilities: capabilities(['user:read']) });

    const response = await resetMfa(test, adminToken, COLLEAGUE).expect(403);

    expect((response.body as { code: string }).code).toBe('user_forbidden');
  });

  it('refuses resetting one’s own account — 409 self_lockout — acceptance 7', async () => {
    const test = createAuthApp({ capabilities: capabilities(['user:reset_mfa']) });

    await request(test.server())
      .post('/api/v1/auth/register')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({
        organization: { name: 'Bad Company', slug: 'bad-company' },
        owner: { email: OWNER, password: PASSWORD },
      })
      .expect(201);

    const login = await request(test.server())
      .post('/api/v1/auth/login')
      .send({ email: OWNER, password: PASSWORD })
      .expect(200);

    const { accessToken, user } = login.body as { accessToken: string; user: { id: string } };

    const response = await resetMfa(test, accessToken, user.id).expect(409);

    expect((response.body as { code: string }).code).toBe('self_lockout');
  });

  it('answers 404 for somebody of another organization — acceptance 9', async () => {
    const { test, adminToken } = await bothSignedIn();

    const response = await resetMfa(test, adminToken, STRANGER).expect(404);

    expect((response.body as { code: string }).code).toBe('user_not_found');
  });

  it('HIGH-1: refuses an admin resetting the organization owner’s 2FA — 403 not_the_owner', async () => {
    const { test, adminToken, colleagueCookie } = await bothSignedIn({
      capabilitiesByUser: {
        [COLLEAGUE]: {
          isOwner: true,
          granted: ['acl:grant', 'audit:export'],
          denied: [],
          roleKeys: ['owner'],
          permissionsVersion: 1,
        },
      },
    });

    expect(colleagueCookie).not.toBe('');
    await enableTotp(test, COLLEAGUE);

    const response = await resetMfa(test, adminToken, COLLEAGUE).expect(403);

    expect((response.body as { code: string; reason: string }).reason).toBe('not_the_owner');

    // Nothing about the owner's account moved.
    //
    // `state` is asserted present before `enabledAt` is read, and that is the whole point: the
    // finder answers `null` when there is no enrolment at all, `state?.enabledAt` is then
    // `undefined`, and `expect(undefined).not.toBeNull()` **passes** — the assertion was satisfied
    // by exactly the outcome it exists to forbid. Proven 2026-08-30 by hoisting
    // `enrollment.disable(subject.id)` above the policy call in `reset-user-mfa.use-case.ts`: the
    // owner's second factor was wiped, a 403 came back, and this case stayed green.
    const state = await test.enrollment.find(COLLEAGUE);

    expect(state).not.toBeNull();
    expect(state?.enabledAt).not.toBeNull();
    expect(test.dispatcher.dispatched).toEqual([]);
    expect(test.audit.events.map((event) => event.action)).not.toContain('user.mfa_reset_by_admin');

    const after = await request(test.server())
      .post('/api/v1/auth/refresh')
      .set('Cookie', colleagueCookie)
      .set('Origin', APP_URL)
      .expect(200);

    expect(after.status).toBe(200);
  });

  it('HIGH-1: refuses an admin against a colleague who holds a permission the admin does not — T-IAM-09', async () => {
    const { test, adminToken } = await bothSignedIn({
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

    const response = await resetMfa(test, adminToken, COLLEAGUE).expect(403);

    expect((response.body as { reason: string }).reason).toBe('permission_not_granted');
  });

  it('CONTROL: HIGH-1 does not block a reset once the caller holds that permission too', async () => {
    const { test, adminToken } = await bothSignedIn({
      capabilities: capabilities(['user:reset_mfa', 'role:update']),
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

    const response = await resetMfa(test, adminToken, COLLEAGUE).expect(200);

    expect((response.body as ResetResult).wasEnabled).toBe(false);
  });

  it('MEDIUM-2: refuses the sixth reset in the window with 429 rate_limited', async () => {
    const { test, adminToken } = await bothSignedIn({
      rateLimit: { limits: { mfa_admin_reset_attempt: 5 } },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await resetMfa(test, adminToken, COLLEAGUE, `${attempt}`.repeat(32).slice(0, 32)).expect(200);
    }

    const response = await resetMfa(test, adminToken, COLLEAGUE, 'z'.repeat(32)).expect(429);

    expect((response.body as { code: string }).code).toBe('rate_limited');
    expect(response.headers['retry-after']).toBeDefined();
  });

  it('refuses without a session', async () => {
    const test = createAuthApp();

    const response = await resetMfa(test, 'not-a-real-token', COLLEAGUE).expect(401);

    expect((response.body as { code: string }).code).toBe('unauthenticated');
  });
});

/**
 * Criterion 5 of the story, at the only level that can show it: the same property
 * `user-lifecycle.test.ts`'s identically named describe block proves for offboarding.
 */
describe('ending the sessions of the person whose 2FA is reset', () => {
  it('reports a non-zero count and revokes with reason MFA_RESET_BY_ADMIN', async () => {
    const { test, adminToken, colleagueCookie } = await bothSignedIn();

    expect(colleagueCookie).not.toBe('');
    await enableTotp(test, COLLEAGUE);

    const body = (await resetMfa(test, adminToken, COLLEAGUE).expect(200)).body as ResetResult;

    expect(body.sessionsRevoked).toBeGreaterThan(0);

    const colleagueSessions = [...test.sessions.rows.values()].filter(
      (row) => row.userId === COLLEAGUE,
    );

    expect(colleagueSessions).not.toHaveLength(0);
    expect(colleagueSessions.every((row) => row.revokedReason === 'MFA_RESET_BY_ADMIN')).toBe(true);
  });

  it('CONTROL: the refresh cookie works before the reset and not after it', async () => {
    const { test, adminToken, colleagueCookie } = await bothSignedIn();

    await enableTotp(test, COLLEAGUE);

    // The positive control. Without it, a cookie that never worked would make the 401 below prove
    // nothing at all.
    const before = await request(test.server())
      .post('/api/v1/auth/refresh')
      .set('Cookie', colleagueCookie)
      .set('Origin', APP_URL)
      .expect(200);

    await resetMfa(test, adminToken, COLLEAGUE).expect(200);

    const after = await request(test.server())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieOf(before))
      .set('Origin', APP_URL)
      .expect(401);

    expect((after.body as { code: string }).code).toBe('unauthenticated');
  });

  it('bumps permissionsVersion so a live access token is stale on its next request', async () => {
    const { test, adminToken } = await bothSignedIn();

    await enableTotp(test, COLLEAGUE);
    await resetMfa(test, adminToken, COLLEAGUE).expect(200);

    expect(test.userRoles.versionBumps).toContain(COLLEAGUE);
  });
});
