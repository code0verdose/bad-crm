import { type SharedPermissions } from '@bad-crm/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createAuthApp, type AuthApp, type AuthAppOptions } from '../../support/auth-app.util.js';
import { authUser, ORGANIZATION_ID, USER_ID } from '../../support/identity-doubles.util.js';

/**
 * The organization's second-factor policy over HTTP (STORY-013-05).
 *
 * What only this level shows: that the policy a `PATCH` stores is the policy the *sign-in gate*
 * reads a moment later, through the tenant root's `settings` column and back out again. The unit
 * suites prove the arithmetic (`test/unit/domain/mfa-requirement.test.ts`) and the route table
 * proves the scope (`test/unit/http/mfa-enrollment-scope.test.ts`); neither can show that the two
 * halves are talking about the same policy.
 */

const IDEMPOTENCY_KEY = 'f'.repeat(32);
const PASSWORD = 'correct-horse-battery';
const OWNER_EMAIL = 'ada@example.com';
const POLICY_PATH = '/api/v1/organization/security-policy';

const DAY_MS = 24 * 60 * 60 * 1000;

const capabilities = (
  granted: readonly SharedPermissions.PermissionKey[],
): NonNullable<AuthAppOptions['capabilities']> => ({
  isOwner: false,
  granted: [...granted],
  denied: [],
  roleKeys: [],
  permissionsVersion: 1,
});

const appWith = (
  granted: readonly SharedPermissions.PermissionKey[] = ['organization:manage_security_policy'],
): AuthApp => createAuthApp({ accounts: [authUser()], capabilities: capabilities(granted) });

const signIn = async (test: AuthApp): Promise<{ accessToken: string }> => {
  const response = await request(test.server())
    .post('/api/v1/auth/login')
    .send({ email: OWNER_EMAIL, password: PASSWORD })
    .expect(200);

  return response.body as { accessToken: string };
};

/** Puts the caller under a covering role, granted `grantedDaysAgo` days before now. */
const grantRole = (
  test: AuthApp,
  roleKey: string,
  grantedDaysAgo: number,
  userId = USER_ID,
): void => {
  test.mfaPolicyReader.grants.set(userId, [
    {
      roleKey,
      roleId: `role-${roleKey}`,
      grantedAt: new Date(test.clock.now().getTime() - grantedDaysAgo * DAY_MS),
    },
  ]);
};

const patchPolicy = (test: AuthApp, token: string, body: Record<string, unknown>): request.Test =>
  request(test.server())
    .patch(POLICY_PATH)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', IDEMPOTENCY_KEY)
    .send(body);

describe('PATCH /organization/security-policy', () => {
  it('stores the policy and files a CRITICAL trail entry with before and after — acceptance 1', async () => {
    const test = appWith();
    const { accessToken } = await signIn(test);

    const response = await patchPolicy(test, accessToken, {
      mfaRequiredForRoles: ['owner', 'admin', 'manager'],
      mfaGracePeriodDays: 7,
    }).expect(200);

    expect(response.body.mfaRequiredForRoles).toEqual(['owner', 'admin', 'manager']);
    expect(response.body.mfaGracePeriodDays).toBe(7);
    // The dates the client never sends and the countdown of acceptance 5 rests on.
    expect(Object.keys(response.body.mfaRequiredSince).sort()).toEqual([
      'admin',
      'manager',
      'owner',
    ]);

    const entry = test.audit.events.find(
      (event) => event.action === 'organization.security_policy_updated',
    );

    expect(entry).toBeDefined();
    expect(entry?.target).toEqual({ type: 'ORGANIZATION', id: ORGANIZATION_ID });
    expect(entry?.before).toMatchObject({ mfaRequiredForRoles: [] });
    expect(entry?.after).toMatchObject({ mfaRequiredForRoles: ['owner', 'admin', 'manager'] });
  });

  it('reads back what it wrote — acceptance 1, the other direction', async () => {
    const test = appWith();
    const { accessToken } = await signIn(test);

    await patchPolicy(test, accessToken, {
      mfaRequiredForRoles: ['admin'],
      mfaGracePeriodDays: 3,
    }).expect(200);

    const response = await request(test.server())
      .get(POLICY_PATH)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(response.body.mfaRequiredForRoles).toEqual(['admin']);
    expect(response.body.mfaGracePeriodDays).toBe(3);
  });

  it('answers the disabled policy on a fresh installation — acceptance 10', async () => {
    const test = appWith();
    const { accessToken } = await signIn(test);

    const response = await request(test.server())
      .get(POLICY_PATH)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(response.body).toEqual({
      mfaRequiredForRoles: [],
      mfaGracePeriodDays: 0,
      mfaRequiredSince: {},
    });
  });

  it('keeps the start date of a role that was already covered when the grace period changes', async () => {
    const test = appWith();
    const { accessToken } = await signIn(test);

    const first = await patchPolicy(test, accessToken, {
      mfaRequiredForRoles: ['admin'],
      mfaGracePeriodDays: 7,
    }).expect(200);

    test.clock.advance(5 * 24 * 60 * 60);

    const second = await patchPolicy(test, accessToken, {
      mfaRequiredForRoles: ['admin', 'manager'],
      mfaGracePeriodDays: 14,
    }).expect(200);

    // `admin` keeps the day it entered the policy; `manager` starts today. Restarting the first
    // would silently un-enforce a policy that had already come into force.
    expect(second.body.mfaRequiredSince.admin).toBe(first.body.mfaRequiredSince.admin);
    expect(second.body.mfaRequiredSince.manager).not.toBe(first.body.mfaRequiredSince.admin);
  });

  it('refuses a caller without the capability — acceptance 8', async () => {
    const test = appWith(['organization:read']);
    const { accessToken } = await signIn(test);

    const response = await patchPolicy(test, accessToken, {
      mfaRequiredForRoles: [],
      mfaGracePeriodDays: 0,
    }).expect(403);

    expect(response.body.reason).toBe('permission_not_granted');
  });

  it('refuses a role id that names no role of this organization, as 404 rather than 403', async () => {
    const test = appWith();
    const { accessToken } = await signIn(test);

    const response = await patchPolicy(test, accessToken, {
      mfaRequiredForRoles: ['11111111-1111-4111-8111-111111111111'],
      mfaGracePeriodDays: 0,
    }).expect(404);

    expect(response.body.code).toBe('role_not_found');
  });

  it.each([
    [
      'a role reference that is neither a system key nor a uuid',
      { mfaRequiredForRoles: ['admins'] },
    ],
    ['a grace period beyond thirty days', { mfaGracePeriodDays: 31 }],
    ['a negative grace period', { mfaGracePeriodDays: -1 }],
    ['a client-supplied start date', { mfaRequiredSince: { admin: '2020-01-01T00:00:00.000Z' } }],
  ])('refuses %s', async (_case, patch) => {
    const test = appWith();
    const { accessToken } = await signIn(test);

    const response = await patchPolicy(test, accessToken, {
      mfaRequiredForRoles: [],
      mfaGracePeriodDays: 0,
      ...patch,
    }).expect(422);

    expect(response.body.code).toBe('validation_failed');
  });
});

/**
 * Acceptance 7. The owner is not blocked from putting themselves under the policy — that is how it
 * gets adopted — but they are not allowed to do it without being told.
 */
describe('the self-lockout confirmation', () => {
  it('refuses once with 428 and performs on the repeat', async () => {
    const test = appWith();
    const { accessToken } = await signIn(test);

    grantRole(test, 'owner', 0);

    const refused = await patchPolicy(test, accessToken, {
      mfaRequiredForRoles: ['owner'],
      mfaGracePeriodDays: 0,
    }).expect(428);

    expect(refused.body.code).toBe('confirmation_required');

    // Nothing was stored by the refusal.
    const stored = await request(test.server())
      .get(POLICY_PATH)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(stored.body.mfaRequiredForRoles).toEqual([]);

    const confirmed = await patchPolicy(test, accessToken, {
      mfaRequiredForRoles: ['owner'],
      mfaGracePeriodDays: 0,
      confirmedSelfLockout: true,
    }).expect(200);

    expect(confirmed.body.mfaRequiredForRoles).toEqual(['owner']);
  });

  it('does not ask when the caller already has a second factor', async () => {
    const test = appWith();
    const { accessToken } = await signIn(test);

    grantRole(test, 'owner', 0);
    await test.enrollment.beginDraft(USER_ID, 'enc:secret', new Date(Date.now() + 60_000));
    await test.enrollment.commitEnrollment(USER_ID, 1, test.clock.now());

    const response = await patchPolicy(test, accessToken, {
      mfaRequiredForRoles: ['owner'],
      mfaGracePeriodDays: 0,
    }).expect(200);

    expect(response.body.mfaRequiredForRoles).toEqual(['owner']);
  });

  it('does not ask when the policy covers none of the caller’s roles', async () => {
    const test = appWith();
    const { accessToken } = await signIn(test);

    grantRole(test, 'developer', 0);

    const response = await patchPolicy(test, accessToken, {
      mfaRequiredForRoles: ['admin'],
      mfaGracePeriodDays: 0,
    }).expect(200);

    expect(response.body.mfaRequiredForRoles).toEqual(['admin']);
  });
});

/**
 * Acceptance 3 and 4, end to end: the policy is written over HTTP, and the *next sign-in* is the one
 * that answers with a scoped token or an ordinary one.
 */
describe('the sign-in gate', () => {
  const enablePolicy = async (test: AuthApp, graceDays: number): Promise<void> => {
    const { accessToken } = await signIn(test);

    await patchPolicy(test, accessToken, {
      mfaRequiredForRoles: ['admin'],
      mfaGracePeriodDays: graceDays,
      confirmedSelfLockout: true,
    }).expect(200);
  };

  it('leaves a covered account inside its grace period with an ordinary session — acceptance 4', async () => {
    const test = appWith();

    await enablePolicy(test, 7);
    grantRole(test, 'admin', 0);

    const response = await request(test.server())
      .post('/api/v1/auth/login')
      .send({ email: OWNER_EMAIL, password: PASSWORD })
      .expect(200);

    expect(response.body.mfaEnrollment).toBeUndefined();
    // The banner of acceptance 4 needs a date to count down to, and it is present exactly when the
    // policy covers the caller.
    expect(typeof response.body.mfaGraceEndsAt).toBe('string');
  });

  it('scopes the session once the grace period is over — acceptance 3', async () => {
    const test = appWith();

    await enablePolicy(test, 0);
    grantRole(test, 'admin', 0);

    const login = await request(test.server())
      .post('/api/v1/auth/login')
      .send({ email: OWNER_EMAIL, password: PASSWORD })
      .expect(200);

    expect(login.body.mfaEnrollment).toBe(true);

    const token = (login.body as { accessToken: string }).accessToken;

    // The wizard is reachable…
    await request(test.server())
      .post('/api/v1/auth/2fa/setup')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // …and nothing else is.
    const refused = await request(test.server())
      .get('/api/v1/me/permissions')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(refused.body.code).toBe('mfa_enrollment_required');
  });

  it('gives a colleague promoted later their own countdown — acceptance 5', async () => {
    const test = appWith();

    await enablePolicy(test, 7);

    // The policy came into force today; the role arrives eight days later. Counting from the policy
    // would lock them out on arrival, which is the defect acceptance 5 names.
    test.clock.advance(8 * 24 * 60 * 60);
    grantRole(test, 'admin', 0);

    const login = await request(test.server())
      .post('/api/v1/auth/login')
      .send({ email: OWNER_EMAIL, password: PASSWORD })
      .expect(200);

    const allowed = await request(test.server())
      .get('/api/v1/me/permissions')
      .set('Authorization', `Bearer ${(login.body as { accessToken: string }).accessToken}`)
      .expect(200);

    expect(allowed.body.permissions).toBeDefined();
  });

  it('drops the requirement when the covering role is taken away — acceptance 5, second half', async () => {
    const test = appWith();

    await enablePolicy(test, 0);
    grantRole(test, 'admin', 0);
    test.mfaPolicyReader.grants.set(USER_ID, []);

    const login = await request(test.server())
      .post('/api/v1/auth/login')
      .send({ email: OWNER_EMAIL, password: PASSWORD })
      .expect(200);

    const allowed = await request(test.server())
      .get('/api/v1/me/permissions')
      .set('Authorization', `Bearer ${(login.body as { accessToken: string }).accessToken}`)
      .expect(200);

    expect(allowed.body.permissions).toBeDefined();
  });
});

describe('GET /organization/mfa-coverage', () => {
  it('counts who is covered and who has enrolled — acceptance 9', async () => {
    const test = appWith();
    const { accessToken } = await signIn(test);

    test.mfaPolicyReader.subjects.push(
      {
        userId: USER_ID,
        email: OWNER_EMAIL,
        totpEnabledAt: null,
        roles: [{ roleKey: 'admin', roleId: 'role-admin', grantedAt: test.clock.now() }],
      },
      {
        userId: 'other',
        email: 'grace@example.com',
        totpEnabledAt: test.clock.now(),
        roles: [{ roleKey: 'admin', roleId: 'role-admin', grantedAt: test.clock.now() }],
      },
      {
        userId: 'third',
        email: 'linus@example.com',
        totpEnabledAt: null,
        roles: [{ roleKey: 'developer', roleId: 'role-developer', grantedAt: test.clock.now() }],
      },
    );

    await patchPolicy(test, accessToken, {
      mfaRequiredForRoles: ['admin'],
      mfaGracePeriodDays: 0,
      confirmedSelfLockout: true,
    }).expect(200);

    const response = await request(test.server())
      .get('/api/v1/organization/mfa-coverage')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(response.body.covered).toBe(2);
    expect(response.body.enrolled).toBe(1);
    expect(response.body.rows).toHaveLength(3);
    expect(response.body.rows.find((row: { userId: string }) => row.userId === 'third').gate).toBe(
      'not_covered',
    );
  });

  /** Acceptance 2: the confirmation preview, answered by the same query as the standing report. */
  it('reports against an unsaved draft when one is passed', async () => {
    const test = appWith();
    const { accessToken } = await signIn(test);

    test.mfaPolicyReader.subjects.push({
      userId: 'other',
      email: 'grace@example.com',
      totpEnabledAt: null,
      roles: [{ roleKey: 'manager', roleId: 'role-manager', grantedAt: test.clock.now() }],
    });

    const response = await request(test.server())
      .get('/api/v1/organization/mfa-coverage?role=manager&graceDays=7')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // Nothing is stored, and the draft is what the report is about.
    expect(response.body.policy.mfaRequiredForRoles).toEqual(['manager']);
    expect(response.body.covered).toBe(1);
    expect(response.body.rows[0].gate).toBe('grace');
  });

  it('refuses a caller without the capability', async () => {
    const test = appWith(['organization:read']);
    const { accessToken } = await signIn(test);

    const response = await request(test.server())
      .get('/api/v1/organization/mfa-coverage')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);

    expect(response.body.reason).toBe('permission_not_granted');
  });
});

/**
 * Acceptance 11. The policy lives in a column of the tenant root, read through `withTenant`, so an
 * organization's policy is unreachable from another one's scope — and this is what proves the
 * *application* honours that rather than carrying the policy in some ambient place. The row-level
 * half is the tenant root's own isolation test, which this epic adds no table to.
 */
describe('cross-tenancy', () => {
  it('applies only the caller’s own organization’s policy', async () => {
    const first = appWith();
    const second = appWith();

    const { accessToken } = await signIn(first);

    await patchPolicy(first, accessToken, {
      mfaRequiredForRoles: ['admin'],
      mfaGracePeriodDays: 0,
      confirmedSelfLockout: true,
    }).expect(200);

    // The second organization holds the same role and no policy of its own.
    grantRole(second, 'admin', 0);

    const login = await request(second.server())
      .post('/api/v1/auth/login')
      .send({ email: OWNER_EMAIL, password: PASSWORD })
      .expect(200);

    const allowed = await request(second.server())
      .get('/api/v1/me/permissions')
      .set('Authorization', `Bearer ${(login.body as { accessToken: string }).accessToken}`)
      .expect(200);

    expect(allowed.body.permissions).toBeDefined();
  });
});
