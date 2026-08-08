import { describe, expect, it } from 'vitest';

import { type EmployeeProfileRow } from '@/application/iam/ports/employee-profile-repository.port.js';
import { serializeEmployee } from '@/presentation/http/serializers/employee.serializer.js';

/**
 * What each audience sees of a profile — asserted on the **absence** of keys, which is the half
 * that fails silently.
 *
 * A field a caller may not see is not a field rendered greyed out: it must not be in the answer at
 * all. The client cannot be the filter — anybody can read a response — so the shape below is the
 * whole of the protection, and these cases are what keeps it true after the next field is added
 * (`T-PROJ-05`, and `permission-model.md` §4.1 for the cost half).
 */

const row: EmployeeProfileRow = {
  userId: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5ad1',
  email: 'ivan@example.test',
  firstName: 'Ivan',
  lastName: 'Petrov',
  jobTitle: 'Backend engineer',
  department: 'Platform',
  managerId: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5ad2',
  weeklyCapacityHours: 40,
  employmentType: 'FULL_TIME',
  hiredAt: new Date('2024-03-01T00:00:00.000Z'),
  terminatedAt: null,
  timezone: 'Europe/Moscow',
  skills: ['ts', 'postgres'],
  emergencyContactEnc: 'v1:iv:tag:ciphertext',
};

const HR_KEYS = [
  'employmentType',
  'hiredAt',
  'terminatedAt',
  'weeklyCapacityHours',
  'emergencyContact',
];

describe('a colleague without `employee:view_personal_data`', () => {
  const answer = serializeEmployee({
    profile: row,
    audience: { personal: false, cost: false },
    emergencyContact: null,
  });

  it('sees who the person is and how to work with them', () => {
    expect(answer).toMatchObject({
      firstName: 'Ivan',
      lastName: 'Petrov',
      jobTitle: 'Backend engineer',
      skills: ['ts', 'postgres'],
    });
  });

  it.each(HR_KEYS)('does not receive the key `%s` at all', (key) => {
    expect(answer).not.toHaveProperty(key);
  });

  it('never receives the ciphertext either', () => {
    expect(JSON.stringify(answer)).not.toContain('v1:');
  });
});

describe('HR, and the person reading their own record', () => {
  const answer = serializeEmployee({
    profile: row,
    audience: { personal: true, cost: false },
    emergencyContact: 'sister, +7 900 000-00-00',
  });

  it('sees the employment', () => {
    expect(answer).toMatchObject({
      employmentType: 'FULL_TIME',
      weeklyCapacityHours: 40,
      emergencyContact: 'sister, +7 900 000-00-00',
    });
  });

  it('gets the hiring date as a date, not as an instant', () => {
    // Nobody is hired at 14:32, and an ISO instant renders as the day before for half the planet.
    expect(answer).toMatchObject({ hiredAt: '2024-03-01' });
  });

  it('never receives the ciphertext beside the plaintext', () => {
    expect(JSON.stringify(answer)).not.toContain('v1:');
  });
});

/**
 * The one that has to hold for **every** level, including the widest.
 *
 * Rates live in `cost_rates` (M6) and `employee:view_cost_rate` is held by finance rather than by
 * administrators. Separation of duties only means something if it survives the moment somebody
 * writes `isAdmin ? everything : …`, so the absence is asserted here rather than assumed from the
 * table not having the column yet.
 */
describe('no audience of this serializer emits money', () => {
  it.each([
    ['a colleague', { personal: false, cost: false }],
    ['HR', { personal: true, cost: false }],
    ['finance', { personal: false, cost: true }],
    ['somebody holding every employee capability there is', { personal: true, cost: true }],
  ])('%s receives no `cost*` key', (_name, audience) => {
    const answer = serializeEmployee({ profile: row, audience, emergencyContact: null });

    expect(Object.keys(answer).filter((key) => key.toLowerCase().startsWith('cost'))).toEqual([]);
  });
});

describe('the finance audience is not the top of a ladder', () => {
  it('receives none of the employment half, and no decrypted contact', () => {
    // The built-in `manager` holds `employee:view_cost_rate` and not `view_personal_data`. Written
    // as widening levels, this caller received everything; the flags are what make the two
    // independent. `emergencyContact` is `null` here because the use-case never decrypted it — a
    // value that was never decrypted cannot be serialised by mistake.
    const answer = serializeEmployee({
      profile: row,
      audience: { personal: false, cost: true },
      emergencyContact: null,
    });

    for (const key of HR_KEYS) expect(answer).not.toHaveProperty(key);
    // CONTROL: the public half arrived, so the absence above is about the audience.
    expect(answer).toMatchObject({ firstName: 'Ivan' });
  });
});
