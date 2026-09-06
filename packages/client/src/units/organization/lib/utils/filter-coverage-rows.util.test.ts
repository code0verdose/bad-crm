import { describe, expect, it } from 'vitest';

import { type MfaCoverageRow } from '@units/organization/api';

import { filterCoverageRows } from './filter-coverage-rows.util.js';

/**
 * The narrowing of the coverage report, which happens **on the client** — and does so because the
 * contract says to: `GET /organization/mfa-coverage` is unpaged on purpose («the client filters it in
 * the URL», `docs/api/openapi.yaml`), so that «how many are not enrolled» cannot become a second
 * request that disagrees with the first.
 *
 * A pure function rather than a `useMemo` in the table, so the three rules below are stated once and
 * can be shown wrong: an empty filter is «everything» and not «nothing», the phrase is matched
 * case-insensitively against the address, and the two multi-selects are an AND of ORs — a person
 * shown under «admin + grace» holds `admin` **and** is in their grace period.
 */

const row = (over: Partial<MfaCoverageRow>): MfaCoverageRow => ({
  userId: '018f4a3b-2c1d-7a41-9f00-000000000001',
  email: 'ivan@example.test',
  roleKeys: ['developer'],
  gate: 'not_covered',
  ...over,
});

const NOBODY: MfaCoverageRow[] = [];

const ALL: readonly MfaCoverageRow[] = [
  row({ email: 'owner@example.test', roleKeys: ['owner'], gate: 'satisfied' }),
  row({ email: 'Ada@example.test', roleKeys: ['admin'], gate: 'grace' }),
  row({ email: 'boris@example.test', roleKeys: ['admin', 'manager'], gate: 'enrollment_required' }),
  row({ email: 'dev@example.test', roleKeys: ['developer'], gate: 'not_covered' }),
];

const addresses = (rows: readonly MfaCoverageRow[]): string[] => rows.map((entry) => entry.email);

describe('filterCoverageRows', () => {
  it('CONTROL: an empty filter is everybody, not nobody', () => {
    expect(filterCoverageRows(ALL, { q: '', role: [], gate: [] })).toEqual(ALL);
  });

  it('matches the phrase against the address, ignoring case and surrounding spaces', () => {
    expect(addresses(filterCoverageRows(ALL, { q: '  ADA ', role: [], gate: [] }))).toEqual([
      'Ada@example.test',
    ]);
  });

  it('keeps a person who holds any of the selected roles', () => {
    expect(addresses(filterCoverageRows(ALL, { q: '', role: ['manager'], gate: [] }))).toEqual([
      'boris@example.test',
    ]);
  });

  it('keeps a person whose verdict is any of the selected ones', () => {
    expect(
      addresses(
        filterCoverageRows(ALL, { q: '', role: [], gate: ['grace', 'enrollment_required'] }),
      ),
    ).toEqual(['Ada@example.test', 'boris@example.test']);
  });

  it('ANDs the three: a role that matches with a verdict that does not keeps nobody', () => {
    expect(filterCoverageRows(ALL, { q: '', role: ['admin'], gate: ['satisfied'] })).toEqual(
      NOBODY,
    );
  });
});
