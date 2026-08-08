import { describe, expect, it } from 'vitest';

import { type VisibleDirectoryPage } from '@/application/iam/use-cases/list-employees.query.js';
import {
  serializeEmployeeList,
  serializeOrgChart,
} from '@/presentation/http/serializers/employee-list-item.serializer.js';

import { directoryRow } from '../../support/iam-doubles.util.js';

/**
 * What a directory row is on the wire.
 *
 * The property under test is **absence**: a caller who may not see the employment half must not
 * receive the keys at all — not empty ones, not nulls. A client is not a filter, because anybody can
 * read a response, and «it was null so nothing was shown» is a filter that lives on the wrong side.
 *
 * And no key here begins with `cost`, at any level, including for a caller holding every employee
 * capability there is. Rates arrive in M6 with their own table and their own permission; this test
 * is what a reader can point at to be sure of the claim without reading the schema
 * (`permission-model.md` §4.1).
 */

const ME = '018f4a3b-0000-7000-8000-00000000001a';

/**
 * The three audiences a caller can belong to, by the capability that grants each.
 *
 * Named as flags rather than as levels because that is what they are: `cost` is held by the built-in
 * `manager` **without** `personal`, so «cost implies personal» is not a shortcut, it is the
 * privilege escalation this file now guards against.
 */
const COLLEAGUE_AUDIENCE = { personal: false, cost: false } as const;
const HR_AUDIENCE = { personal: true, cost: false } as const;
const FINANCE_AUDIENCE = { personal: false, cost: true } as const;
const EVERY_AUDIENCE = { personal: true, cost: true } as const;

const pageOf = (audience: { personal: boolean; cost: boolean }): VisibleDirectoryPage => ({
  items: [
    {
      row: directoryRow({
        userId: ME,
        roles: [{ id: 'r-1', key: 'developer', name: 'Developer' }],
        teams: [{ id: 't-1', name: 'Platform' }],
      }),
      audience,
    },
  ],
  total: 1,
  page: 1,
  perPage: 25,
  facets: { roles: [], teams: [] },
  sort: 'name',
});

describe('a directory row', () => {
  it('carries who the person is and where they sit, for anybody', () => {
    const [item] = serializeEmployeeList(pageOf(COLLEAGUE_AUDIENCE)).items;

    expect(item).toEqual({
      userId: ME,
      email: `${ME}@example.test`,
      firstName: 'Ivan',
      lastName: 'Petrov',
      jobTitle: 'Backend engineer',
      department: 'Platform',
      status: 'ACTIVE',
      managerId: null,
      roles: [{ id: 'r-1', key: 'developer', name: 'Developer' }],
      teams: [{ id: 't-1', name: 'Platform' }],
    });
  });

  it('has no employment key at all for a colleague', () => {
    const [item] = serializeEmployeeList(pageOf(COLLEAGUE_AUDIENCE)).items;

    for (const key of ['employmentType', 'hiredAt', 'terminatedAt', 'weeklyCapacityHours']) {
      expect(item).not.toHaveProperty(key);
    }
  });

  it('adds the employment for the person themselves and for HR', () => {
    const [item] = serializeEmployeeList(pageOf(HR_AUDIENCE)).items;

    expect(item).toMatchObject({
      employmentType: 'FULL_TIME',
      // A day, not an instant: an ISO timestamp renders as the day before for half the planet.
      hiredAt: '2024-03-01',
      terminatedAt: null,
      weeklyCapacityHours: 40,
    });
  });

  it.each([
    ['a colleague', COLLEAGUE_AUDIENCE],
    ['HR', HR_AUDIENCE],
    ['finance', FINANCE_AUDIENCE],
    ['somebody holding every employee capability there is', EVERY_AUDIENCE],
  ])('never carries a cost key for %s', (_name, audience) => {
    const [item] = serializeEmployeeList(pageOf(audience)).items;

    expect(Object.keys(item ?? {}).filter((key) => key.startsWith('cost'))).toEqual([]);
  });

  it('gives the finance audience none of the employment half', () => {
    // `cost` is not the top of a ladder: the built-in `manager` holds it and not
    // `employee:view_personal_data`, so a row folded for them must look like a colleague's.
    const [item] = serializeEmployeeList(pageOf(FINANCE_AUDIENCE)).items;

    for (const key of ['employmentType', 'hiredAt', 'terminatedAt', 'weeklyCapacityHours']) {
      expect(item).not.toHaveProperty(key);
    }
    // CONTROL: the public half is there, so the absence above is about the audience.
    expect(item).toMatchObject({ firstName: 'Ivan' });
  });
});

describe('the envelope', () => {
  it('reports the order the rows are actually in', () => {
    const page = serializeEmployeeList({ ...pageOf(COLLEAGUE_AUDIENCE), sort: '-name' });

    expect(page).toMatchObject({ total: 1, page: 1, perPage: 25, sort: '-name' });
  });
});

describe('the org chart', () => {
  it('carries names and edges, and nothing of the employment', () => {
    const chart = serializeOrgChart([
      { userId: ME, firstName: 'Ivan', lastName: 'Petrov', jobTitle: null, managerId: null },
    ]);

    expect(Object.keys(chart.nodes[0] ?? {})).toEqual([
      'userId',
      'firstName',
      'lastName',
      'jobTitle',
      'managerId',
    ]);
  });
});
