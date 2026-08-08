import { SharedPermissions } from '@bad-crm/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { GetOrgChartQuery } from '@/application/iam/use-cases/get-org-chart.query.js';
import { ListEmployeesQuery } from '@/application/iam/use-cases/list-employees.query.js';
import { type Actor } from '@/domain/access/actor.types.js';

import { directoryRow, FakeEmployeeDirectoryRepository } from '../../support/iam-doubles.util.js';
import { FakeUnitOfWork } from '../../support/identity-doubles.util.js';

/**
 * The directory as a decision rather than as a list.
 *
 * The route's guard already answered «may this caller read the directory at all», so what is left
 * here are the two questions it could not:
 *
 *   * **what a page is ordered by.** An order is a question about a column, and paging a list sorted
 *     by hiring date teaches you everybody's hiring date one comparison at a time — so an employment
 *     order asked for without `employee:view_personal_data` is answered by name, and the answer says
 *     so rather than pretending;
 *   * **how much of each row.** Decided per subject, not per request: a person's own line is theirs
 *     to read even when their colleagues' lines are not.
 */

const ME = '018f4a3b-0000-7000-8000-00000000001a';
const COLLEAGUE = '018f4a3b-0000-7000-8000-00000000002b';

const actorWith = (granted: readonly string[]): Actor => ({
  userId: ME,
  organizationId: 'org-1',
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set(granted as SharedPermissions.PermissionKey[]),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
});

const filter = (
  overrides: Partial<Parameters<ListEmployeesQuery['execute']>[0]['filter']> = {},
) => ({
  query: '',
  statuses: [] as const,
  roleIds: [] as const,
  teamIds: [] as const,
  sort: 'name' as const,
  page: 1,
  perPage: 25,
  ...overrides,
});

let directory: FakeEmployeeDirectoryRepository;
let query: ListEmployeesQuery;

beforeEach(() => {
  directory = new FakeEmployeeDirectoryRepository();
  query = new ListEmployeesQuery(new FakeUnitOfWork(), directory);
  directory.rows.push(
    directoryRow({ userId: ME, lastName: 'Aaronson' }),
    directoryRow({ userId: COLLEAGUE, lastName: 'Petrov' }),
    directoryRow({
      userId: '018f4a3b-0000-7000-8000-00000000003c',
      lastName: 'Zhukov',
      status: 'SUSPENDED',
    }),
  );
});

describe('which people a directory shows', () => {
  it('hides the deactivated when no status was asked for', async () => {
    // Not gone — the account is suspended and never deleted — but not who somebody is looking for
    // when they open a list of the people who work here.
    const page = await query.execute({ actor: actorWith(['employee:read']), filter: filter() });

    expect(page.items.map((item) => item.row.lastName)).toEqual(['Aaronson', 'Petrov']);
    expect(page.total).toBe(2);
  });

  it('shows them when the status is named explicitly', async () => {
    const page = await query.execute({
      actor: actorWith(['employee:read']),
      filter: filter({ statuses: ['SUSPENDED'] }),
    });

    expect(page.items.map((item) => item.row.lastName)).toEqual(['Zhukov']);
  });

  it('carries the page numbers back so the pager states what it is showing', async () => {
    const page = await query.execute({
      actor: actorWith(['employee:read']),
      filter: filter({ page: 2, perPage: 1 }),
    });

    expect(page).toMatchObject({ page: 2, perPage: 1, total: 2 });
    expect(page.items).toHaveLength(1);
  });
});

describe('what a page may be ordered by', () => {
  it('refuses an employment order to somebody who cannot read the values', async () => {
    const page = await query.execute({
      actor: actorWith(['employee:read']),
      filter: filter({ sort: 'hiredAt' }),
    });

    // Both halves matter: the repository is asked for the order it will actually use, and the answer
    // reports it — a control claiming «by hiring date» over rows sorted by name is a lie the reader
    // discovers by counting.
    expect(directory.asked[0]?.sort).toBe('name');
    expect(page.sort).toBe('name');
  });

  it('allows it to somebody who can', async () => {
    const page = await query.execute({
      actor: actorWith(['employee:read', 'employee:view_personal_data']),
      filter: filter({ sort: '-hiredAt' }),
    });

    expect(page.sort).toBe('-hiredAt');
  });

  it('never refuses an order by name, which anybody may read', async () => {
    const page = await query.execute({
      actor: actorWith([]),
      filter: filter({ sort: '-name' }),
    });

    expect(page.sort).toBe('-name');
  });
});

describe('how much of each row', () => {
  it('gives me my own line and not my colleagues’', async () => {
    const page = await query.execute({ actor: actorWith(['employee:read']), filter: filter() });
    const audiences = new Map(page.items.map((item) => [item.row.userId, item.audience.personal]));

    expect(audiences.get(ME)).toBe(true);
    expect(audiences.get(COLLEAGUE)).toBe(false);
  });

  it('gives HR every line', async () => {
    const page = await query.execute({
      actor: actorWith(['employee:read', 'employee:view_personal_data']),
      filter: filter(),
    });

    expect(page.items.every((item) => item.audience.personal)).toBe(true);
  });

  it('gives the cost audience no more of a colleague’s line than a colleague gets', async () => {
    const page = await query.execute({
      actor: actorWith(['employee:read', 'employee:view_cost_rate']),
      filter: filter(),
    });
    const colleague = page.items.find((item) => item.row.userId === COLLEAGUE);

    expect(colleague?.audience).toEqual({ personal: false, cost: true });
  });
});

describe('the values the filters can take', () => {
  it('answers the roles and teams somebody actually holds', async () => {
    directory.rows.push(
      directoryRow({
        userId: '018f4a3b-0000-7000-8000-00000000004d',
        roles: [{ id: 'r-1', key: 'developer', name: 'Developer' }],
        teams: [{ id: 't-1', name: 'Platform' }],
      }),
    );

    const page = await query.execute({ actor: actorWith(['employee:read']), filter: filter() });

    expect(page.facets.roles).toEqual([{ id: 'r-1', key: 'developer', name: 'Developer' }]);
    expect(page.facets.teams).toEqual([{ id: 't-1', name: 'Platform' }]);
  });
});

describe('the org chart', () => {
  it('asks for every node once, whatever the size of the company', async () => {
    const nodes = await new GetOrgChartQuery(new FakeUnitOfWork(), directory).execute({
      actor: actorWith(['employee:view_org_chart']),
    });

    // The suspended one is on the chart: a person who still manages somebody is still on it, and
    // dropping them would silently reparent their reports to the root.
    expect(nodes).toHaveLength(3);
    expect(Object.keys(nodes[0] ?? {})).toEqual([
      'userId',
      'firstName',
      'lastName',
      'jobTitle',
      'managerId',
    ]);
  });
});
