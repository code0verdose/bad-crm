import { type SharedPermissions } from '@bad-crm/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { AesFieldEncryption } from '@/infrastructure/crypto/field-encryption.adapter.js';

import { FakeEmployeeProfileRepository } from '../../support/iam-doubles.util.js';
import { createAuthApp, type AuthApp, type AuthAppOptions } from '../../support/auth-app.util.js';

/**
 * The personnel record over HTTP.
 *
 * What only shows up at this level is the **shape of the answer per audience**: a field a caller may
 * not see has to be absent from the document, not present and empty, because the client is not the
 * filter — anybody can read a response (`T-PROJ-05`).
 */

const IDEMPOTENCY_KEY = 'f'.repeat(32);
const PASSWORD = 'correct-horse-battery';
const OWNER = 'ada@example.com';
const COLLEAGUE = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5ae1';

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

const patch = (
  test: AuthApp,
  token: string,
  userId: string,
  body: Record<string, unknown>,
): request.Test =>
  request(test.app)
    .patch(`/api/v1/employees/${userId}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);

describe('PATCH /api/v1/employees/{userId}', () => {
  it('lets anybody fill in their own name', async () => {
    const employeeProfiles = new FakeEmployeeProfileRepository();
    const { test, token, userId } = await signedIn({
      employeeProfiles,
      capabilities: capabilities([]),
    });

    employeeProfiles.accounts.add(userId);

    const response = await patch(test, token, userId, {
      firstName: 'Ada',
      lastName: 'Lovelace',
      skills: ['ts'],
    }).expect(200);

    expect(response.body).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace', skills: ['ts'] });
  });

  it('refuses an employment field on one’s own record without the capability', async () => {
    const employeeProfiles = new FakeEmployeeProfileRepository();
    const { test, token, userId } = await signedIn({
      employeeProfiles,
      capabilities: capabilities([]),
    });

    employeeProfiles.accounts.add(userId);

    const response = await patch(test, token, userId, { weeklyCapacityHours: 80 }).expect(403);

    expect((response.body as { reason: string }).reason).toBe('permission_not_granted');
    expect(employeeProfiles.rows.size).toBe(0);
  });

  it('refuses a capacity the policy and the column both bound', async () => {
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['employee:update']),
    });

    const tooMany = await patch(test, token, userId, { weeklyCapacityHours: 200 }).expect(422);
    const negative = await patch(test, token, userId, { weeklyCapacityHours: -1 }).expect(422);

    expect((tooMany.body as { code: string }).code).toBe('validation_failed');
    expect((negative.body as { code: string }).code).toBe('validation_failed');
  });

  it('answers 422 for an employment that would end before it began', async () => {
    // The database refuses it (`ck_employee_profiles_employment_period`). Without a check in the
    // application the refusal arrives as `23514`, which the error handler has no name for — and a
    // typo in a date form answers 500 `internal_error`.
    const employeeProfiles = new FakeEmployeeProfileRepository();
    const { test, token, userId } = await signedIn({
      employeeProfiles,
      capabilities: capabilities(['employee:update']),
    });

    employeeProfiles.accounts.add(userId);

    const response = await patch(test, token, userId, {
      hiredAt: '2024-03-01',
      terminatedAt: '2023-01-01',
    }).expect(422);

    expect((response.body as { code: string }).code).toBe('employment_period_inverted');
    expect(employeeProfiles.rows.size).toBe(0);
  });

  it('answers 422 when only the termination date arrives and inverts a stored hiring date', async () => {
    // The case a body-level `.refine` could not catch: the request carries one date, and the other
    // has been in the row for months. The comparison has to happen against what the record will
    // hold, inside the transaction that writes it.
    const employeeProfiles = new FakeEmployeeProfileRepository();
    const { test, token, userId } = await signedIn({
      employeeProfiles,
      capabilities: capabilities(['employee:update']),
    });

    employeeProfiles.accounts.add(userId);
    await patch(test, token, userId, { hiredAt: '2024-03-01' }).expect(200);

    const response = await patch(test, token, userId, { terminatedAt: '2023-01-01' }).expect(422);

    expect((response.body as { code: string }).code).toBe('employment_period_inverted');
    // The stored row is untouched: a refused edit writes nothing.
    expect(employeeProfiles.rows.get(userId)?.terminatedAt).toBeNull();
  });

  it('accepts a termination on the hiring date itself, and an open-ended employment', async () => {
    // CONTROL for the two cases above: the guard refuses inversion, not every pair of dates. A
    // one-day contract is a contract, and most people have no termination date at all.
    const employeeProfiles = new FakeEmployeeProfileRepository();
    const { test, token, userId } = await signedIn({
      employeeProfiles,
      capabilities: capabilities(['employee:update']),
    });

    employeeProfiles.accounts.add(userId);

    const sameDay = await patch(test, token, userId, {
      hiredAt: '2024-03-01',
      terminatedAt: '2024-03-01',
    }).expect(200);
    const openEnded = await patch(test, token, userId, { terminatedAt: null }).expect(200);

    // The boundary the database draws too: `ck_employee_profiles_employment_period` is written
    // `terminated_at >= hired_at`, so a one-day contract is legal in both places. Were the two to
    // disagree here, the answer would be a 500 on a perfectly ordinary record.
    expect(sameDay.body).toMatchObject({ hiredAt: '2024-03-01', terminatedAt: '2024-03-01' });
    expect(openEnded.body).toMatchObject({ terminatedAt: null });
  });

  it('will not let a partial date edit read back a colleague’s hiring date', async () => {
    // `employee:update` without `employee:view_personal_data` — no built-in role, but a custom one
    // can. Comparing against the stored row would make the answer depend on a value this caller may
    // not see, and a difference in the answer is a value that can be bisected for. Both dates or
    // neither.
    const employeeProfiles = new FakeEmployeeProfileRepository();
    const { test, token } = await signedIn({
      employeeProfiles,
      capabilities: capabilities(['employee:read', 'employee:update']),
    });

    employeeProfiles.accounts.add(COLLEAGUE);
    employeeProfiles.rows.set(COLLEAGUE, {
      userId: COLLEAGUE,
      email: 'ivan@example.test',
      firstName: 'Ivan',
      lastName: 'Petrov',
      jobTitle: null,
      department: null,
      managerId: null,
      weeklyCapacityHours: 40,
      employmentType: 'FULL_TIME',
      hiredAt: new Date('2024-03-01T00:00:00.000Z'),
      terminatedAt: null,
      timezone: 'UTC',
      skills: [],
      emergencyContactEnc: null,
    });

    // Both probes answer the same way, so neither tells the caller where the stored date sits.
    const above = await patch(test, token, COLLEAGUE, { terminatedAt: '2025-01-01' }).expect(422);
    const below = await patch(test, token, COLLEAGUE, { terminatedAt: '2023-01-01' }).expect(422);

    expect((above.body as { code: string }).code).toBe('employment_period_inverted');
    expect((below.body as { code: string }).code).toBe('employment_period_inverted');

    // And the honest way through: send both, and the pair is judged against itself.
    await patch(test, token, COLLEAGUE, {
      hiredAt: '2024-03-01',
      terminatedAt: '2025-01-01',
    }).expect(200);
  });

  it('sends every employment field through the controller, not only the ones with a rule', async () => {
    // `department`, `employmentType` and `timezone` had no test carrying them over HTTP: the
    // per-field spreads in the controller were never taken, so a typo in one of those keys would
    // have dropped the value silently.
    const employeeProfiles = new FakeEmployeeProfileRepository();
    const { test, token, userId } = await signedIn({
      employeeProfiles,
      capabilities: capabilities(['employee:update']),
    });

    employeeProfiles.accounts.add(userId);

    const response = await patch(test, token, userId, {
      department: 'Platform',
      employmentType: 'PART_TIME',
      timezone: 'Europe/Moscow',
    }).expect(200);

    expect(response.body).toMatchObject({
      department: 'Platform',
      employmentType: 'PART_TIME',
      timezone: 'Europe/Moscow',
    });
  });

  it('accepts a termination on a record with no hiring date at all', async () => {
    // The null boundary of the guard: an employment with no start is a record nobody has filled in,
    // not an inverted period. Refusing here would make offboarding impossible for anybody whose
    // hiring date was never entered.
    const employeeProfiles = new FakeEmployeeProfileRepository();
    const { test, token, userId } = await signedIn({
      employeeProfiles,
      capabilities: capabilities(['employee:update']),
    });

    employeeProfiles.accounts.add(userId);

    const response = await patch(test, token, userId, { terminatedAt: '2023-01-01' }).expect(200);

    expect(response.body).toMatchObject({ hiredAt: null, terminatedAt: '2023-01-01' });
  });

  it('answers 422 for a manager that would close a loop', async () => {
    const employeeProfiles = new FakeEmployeeProfileRepository();
    const { test, token, userId } = await signedIn({
      employeeProfiles,
      capabilities: capabilities(['employee:update']),
    });

    employeeProfiles.accounts.add(userId);
    employeeProfiles.accounts.add(COLLEAGUE);
    // The colleague already reports to me; making them my manager closes the loop.
    await employeeProfiles.upsert(COLLEAGUE, { managerId: userId });

    const response = await patch(test, token, userId, { managerId: COLLEAGUE }).expect(422);

    expect((response.body as { code: string }).code).toBe('manager_cycle_detected');
  });

  it('answers 404 for a person of another organization', async () => {
    const { test, token } = await signedIn({ capabilities: capabilities(['employee:update']) });

    // The account is not in this tenant, so the repository answers nothing — 404, never 403.
    const response = await patch(test, token, COLLEAGUE, { jobTitle: 'Engineer' }).expect(404);

    expect((response.body as { code: string }).code).toBe('user_not_found');
  });

  it('refuses a body with an unknown field instead of ignoring it', async () => {
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['employee:update']),
    });

    const response = await patch(test, token, userId, { weekly_capacity_hours: 40 }).expect(422);

    expect((response.body as { code: string }).code).toBe('validation_failed');
  });
});

describe('GET /api/v1/employees/{userId}', () => {
  const read = (test: AuthApp, token: string, userId: string): request.Test =>
    request(test.app).get(`/api/v1/employees/${userId}`).set('Authorization', `Bearer ${token}`);

  it('gives the person their own employment, emergency contact included', async () => {
    const employeeProfiles = new FakeEmployeeProfileRepository();
    const { test, token, userId } = await signedIn({
      employeeProfiles,
      capabilities: capabilities([]),
    });

    employeeProfiles.accounts.add(userId);
    await patch(test, token, userId, {
      firstName: 'Ada',
      lastName: 'Lovelace',
      emergencyContact: 'sister, +7 900 000-00-00',
    }).expect(200);

    const response = await read(test, token, userId).expect(200);

    expect(response.body).toMatchObject({
      employmentType: 'FULL_TIME',
      weeklyCapacityHours: 40,
      emergencyContact: 'sister, +7 900 000-00-00',
    });
    // The stored form never reaches the wire, only the decrypted one.
    expect(JSON.stringify(response.body)).not.toContain('v1:');
  });

  it('gives a colleague the public half and nothing else', async () => {
    const employeeProfiles = new FakeEmployeeProfileRepository();
    const { test, token, userId } = await signedIn({
      employeeProfiles,
      capabilities: capabilities(['employee:read', 'employee:update']),
    });

    employeeProfiles.accounts.add(COLLEAGUE);
    // `terminatedAt` is stated explicitly, and it has to be: this caller holds `employee:update`
    // without `employee:view_personal_data`, so the period is judged against the body alone — the
    // stored row is not consulted for somebody who may not read it. Editing an employment period
    // blind means stating the whole period.
    await patch(test, token, COLLEAGUE, {
      firstName: 'Ivan',
      lastName: 'Petrov',
      jobTitle: 'Backend engineer',
      hiredAt: '2024-03-01',
      terminatedAt: null,
      emergencyContact: 'sister, +7 900 000-00-00',
    }).expect(200);

    const response = await read(test, token, COLLEAGUE).expect(200);

    expect(response.body).toMatchObject({ firstName: 'Ivan', jobTitle: 'Backend engineer' });
    // Absent keys, not empty ones: the reader of a response is not the one filtering it.
    for (const key of ['hiredAt', 'employmentType', 'weeklyCapacityHours', 'emergencyContact']) {
      expect(response.body).not.toHaveProperty(key);
    }
    expect(String(userId)).not.toBe(COLLEAGUE);
  });

  it('gives HR the employment of somebody else', async () => {
    const employeeProfiles = new FakeEmployeeProfileRepository();
    const { test, token } = await signedIn({
      employeeProfiles,
      capabilities: capabilities([
        'employee:read',
        'employee:update',
        'employee:view_personal_data',
      ]),
    });

    employeeProfiles.accounts.add(COLLEAGUE);
    await patch(test, token, COLLEAGUE, {
      firstName: 'Ivan',
      lastName: 'Petrov',
      hiredAt: '2024-03-01',
    }).expect(200);

    const response = await read(test, token, COLLEAGUE).expect(200);

    expect(response.body).toMatchObject({ hiredAt: '2024-03-01', employmentType: 'FULL_TIME' });
  });

  it('gives the cost audience nothing of the employment half', async () => {
    // The built-in `manager` holds `employee:view_cost_rate` and **not** `view_personal_data`
    // (`permission-model.md` §7). The two are separate audiences, not a ladder: knowing what
    // somebody is paid is not knowing when they were hired, and it is certainly not knowing who to
    // ring if they collapse at their desk. A caller who holds only the first must see neither.
    const employeeProfiles = new FakeEmployeeProfileRepository();
    const { test, token } = await signedIn({
      employeeProfiles,
      capabilities: capabilities(['employee:read', 'employee:view_cost_rate']),
    });

    employeeProfiles.accounts.add(COLLEAGUE);
    employeeProfiles.rows.set(COLLEAGUE, {
      userId: COLLEAGUE,
      email: 'ivan@example.test',
      firstName: 'Ivan',
      lastName: 'Petrov',
      jobTitle: 'Backend engineer',
      department: 'Platform',
      managerId: null,
      weeklyCapacityHours: 20,
      employmentType: 'PART_TIME',
      hiredAt: new Date('2024-03-01T00:00:00.000Z'),
      terminatedAt: null,
      timezone: 'UTC',
      skills: [],
      // Encrypted under the very key the harness wires in, so the assertion below is about the
      // audience rather than about a value nobody could have read anyway.
      emergencyContactEnc: new AesFieldEncryption(Buffer.alloc(32, 7).toString('base64')).encrypt(
        'sister, +7 900 000-00-00',
      ),
    });

    const response = await read(test, token, COLLEAGUE).expect(200);
    const body = response.body as Record<string, unknown>;

    // CONTROL: the public half did arrive, so the assertions below are about the audience and not
    // about an empty answer.
    expect(body).toMatchObject({ firstName: 'Ivan', jobTitle: 'Backend engineer' });

    for (const key of [
      'employmentType',
      'hiredAt',
      'terminatedAt',
      'weeklyCapacityHours',
      'emergencyContact',
    ]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('never emits a key that begins with `cost`, at any level', async () => {
    // Rates live in their own table with their own permission. The absence is asserted rather than
    // assumed, because separation of duties only means something if it survives the next field.
    const employeeProfiles = new FakeEmployeeProfileRepository();
    const { test, token, userId } = await signedIn({
      employeeProfiles,
      capabilities: capabilities(['employee:read', 'employee:view_cost_rate']),
    });

    employeeProfiles.accounts.add(userId);
    const response = await read(test, token, userId).expect(200);

    expect(
      Object.keys(response.body as Record<string, unknown>).filter((key) =>
        key.toLowerCase().startsWith('cost'),
      ),
    ).toEqual([]);
  });

  it('refuses somebody else’s record without employee:read', async () => {
    const { test, token } = await signedIn({ capabilities: capabilities([]) });

    const response = await read(test, token, COLLEAGUE).expect(403);

    expect((response.body as { reason: string }).reason).toBe('permission_not_granted');
  });
});
