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
  status: 'SUSPENDED',
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

/**
 * Every key of the answer, at every depth.
 *
 * `Object.keys(answer)` answers about one level, so «no audience emits money» held only while the
 * shape stayed flat: a rate nested under an object would satisfy it while travelling on the wire.
 */
const deepKeysOf = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(deepKeysOf);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, nested]) => [key, ...deepKeysOf(nested)]);
  }

  return [];
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
    accountStatus: null,
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
    accountStatus: null,
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
    const answer = serializeEmployee({
      profile: row,
      audience,
      emergencyContact: null,
      accountStatus: 'ACTIVE',
    });

    const keys = deepKeysOf(answer);

    // CONTROL: the walk reached the keys of the answer at all — an empty list would satisfy the
    // assertion below for every audience and every future field.
    expect(keys).toContain('firstName');

    expect(keys.filter((key) => key.toLowerCase().startsWith('cost'))).toEqual([]);
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
      accountStatus: null,
    });

    for (const key of HR_KEYS) expect(answer).not.toHaveProperty(key);
    // CONTROL: the public half arrived, so the absence above is about the audience.
    expect(answer).toMatchObject({ firstName: 'Ivan' });
  });
});

/**
 * The state of the account, which is a **fourth** shape rather than a widening of the third.
 *
 * The decision is made by the use-case (`seesAccountStatus`, STORY-012-09 D4-бис) and arrives here as a
 * value or as `null`. `null` is unambiguous: `users.status` is `NOT NULL`, so it can only ever mean
 * «not for this reader», and the key is then absent rather than present and empty — the client is
 * not the filter.
 */
describe('the state of the account travels independently of the employment half', () => {
  it.each([
    ['a colleague', { personal: false, cost: false }],
    ['HR', { personal: true, cost: false }],
    ['finance', { personal: false, cost: true }],
  ])('is absent for %s when the use-case refused it', (_name, audience) => {
    const answer = serializeEmployee({
      profile: row,
      audience,
      emergencyContact: null,
      accountStatus: null,
    });

    expect(answer).not.toHaveProperty('status');
    // CONTROL: the record arrived, so the absence is about the level rather than about an empty
    // answer — and the row does carry a status, so there was something to leak.
    expect(answer).toMatchObject({ firstName: 'Ivan' });
    expect(row.status).toBe('SUSPENDED');
  });

  it.each([
    ['a colleague holding employee:read', { personal: false, cost: false }],
    ['HR holding employee:read', { personal: true, cost: false }],
  ])('is emitted for %s, with the value resolved above', (_name, audience) => {
    const answer = serializeEmployee({
      profile: row,
      audience,
      emergencyContact: null,
      accountStatus: 'SUSPENDED',
    });

    expect(answer).toHaveProperty('status', 'SUSPENDED');
  });

  it('is emitted from what the use-case resolved, not from the row beside it', () => {
    // The row is the wrong source: it carries the state whether or not the caller may see it, and a
    // serializer reading it would be a second answer to a question already decided.
    const answer = serializeEmployee({
      profile: { ...row, status: 'SUSPENDED' },
      audience: { personal: false, cost: false },
      emergencyContact: null,
      accountStatus: 'ACTIVE',
    });

    expect(answer).toHaveProperty('status', 'ACTIVE');
  });
});
