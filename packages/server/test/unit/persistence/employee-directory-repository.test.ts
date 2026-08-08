import { describe, expect, it } from 'vitest';

import { type EmployeeDirectoryFilter } from '@/application/iam/ports/employee-directory-repository.port.js';
import { PrismaEmployeeDirectoryRepository } from '@/infrastructure/persistence/prisma/employee-directory.repository.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * The directory through Prisma, with the driver replaced by a recorder.
 *
 * Three decisions are pinned, and a live database would agree with all three just as happily if they
 * were wrong:
 *
 *   * **a page costs a fixed number of statements.** Not «it looked fast»: the same operation over a
 *     page of one row and a page of fifty must issue the same calls, which is the only form of «no
 *     N+1» that a test can state (acceptance 9 of STORY-012-04);
 *   * **the count and the page share one predicate.** A total obtained from a different `where` is a
 *     pager that promises rows the next page does not have;
 *   * **the order has a tie-breaker that is never null.** Without it, two people with the same
 *     surname — or the many with no personnel row at all — come back in whatever order the plan
 *     produces, so a row can appear on two consecutive pages and another on neither.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000e1';

const baseFilter: EmployeeDirectoryFilter = {
  query: '',
  statuses: ['ACTIVE'],
  roleIds: [],
  teamIds: [],
  sort: 'name',
  page: 1,
  perPage: 25,
};

interface Recorder {
  readonly calls: { name: string; args: Record<string, unknown> }[];
  readonly base: Parameters<typeof withTenant>[0];
}

const account = (index: number, withProfile = false): Record<string, unknown> => ({
  id: `user-${index}`,
  email: `user-${index}@example.test`,
  status: 'ACTIVE',
  employeeProfile: withProfile
    ? {
        firstName: 'Ivan',
        lastName: 'Petrov',
        jobTitle: 'Backend engineer',
        department: 'Platform',
        managerId: 'boss',
        employmentType: 'PART_TIME',
        hiredAt: new Date('2024-03-01T00:00:00.000Z'),
        terminatedAt: null,
        weeklyCapacityHours: 20,
      }
    : null,
  roles: [{ role: { id: 'r-1', key: 'developer', name: 'Developer' } }],
  teamMemberships: [{ team: { id: 't-1', name: 'Platform' } }],
});

const recordingClient = (rows = 1, withProfile = false): Recorder => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const record =
    <T>(name: string, result: T) =>
    (args: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ name, args });

      return Promise.resolve(result);
    };

  const tx = {
    $executeRaw: (): Promise<number> => Promise.resolve(1),
    user: {
      count: record('user.count', rows),
      findMany: record(
        'user.findMany',
        Array.from({ length: rows }, (_, index) => account(index, withProfile)),
      ),
    },
    role: {
      findMany: record('role.findMany', [{ id: 'r-1', key: 'developer', name: 'Developer' }]),
    },
    team: { findMany: record('team.findMany', [{ id: 't-1', name: 'Platform' }]) },
  };

  return {
    calls,
    base: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as Parameters<typeof withTenant>[0],
  };
};

const inScope = async <T>(
  recorder: Recorder,
  work: (repository: PrismaEmployeeDirectoryRepository) => Promise<T>,
): Promise<T> =>
  withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
    work(new PrismaEmployeeDirectoryRepository()),
  );

const argsOf = (recorder: Recorder, name: string): Record<string, unknown> =>
  (recorder.calls.find((call) => call.name === name)?.args ?? {}) as Record<string, unknown>;

describe('a page of the directory', () => {
  it('costs the same number of statements for fifty rows as for one', async () => {
    const one = recordingClient(1);
    const fifty = recordingClient(50);

    await inScope(one, (repository) => repository.list(baseFilter));
    await inScope(fifty, (repository) => repository.list({ ...baseFilter, perPage: 50 }));

    expect(fifty.calls.map((call) => call.name)).toEqual(one.calls.map((call) => call.name));
    expect(one.calls.map((call) => call.name)).toEqual(['user.count', 'user.findMany']);
  });

  it('counts with the predicate the page is read with', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.list(baseFilter));

    expect(argsOf(recorder, 'user.count')['where']).toEqual(
      argsOf(recorder, 'user.findMany')['where'],
    );
  });

  it('never shows a deleted account, whatever the status filter says', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) =>
      repository.list({ ...baseFilter, statuses: ['ACTIVE', 'SUSPENDED', 'INVITED'] }),
    );

    // A deleted row is not a state of a person the directory shows — it is a row kept because other
    // rows point at it.
    expect(argsOf(recorder, 'user.count')['where']).toMatchObject({
      organizationId: ORG,
      deletedAt: null,
    });
  });

  it('breaks ties on a column that is never null', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.list(baseFilter));

    expect(argsOf(recorder, 'user.findMany')['orderBy']).toEqual([
      { employeeProfile: { lastName: 'asc' } },
      { email: 'asc' },
    ]);
  });

  it('turns a page number into an offset of whole pages', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) =>
      repository.list({ ...baseFilter, page: 3, perPage: 10 }),
    );

    expect(argsOf(recorder, 'user.findMany')).toMatchObject({ skip: 20, take: 10 });
  });

  it('searches the fields a person would type into one box', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.list({ ...baseFilter, query: 'ив' }));

    // The **composition**, not the count. `toHaveLength(5)` was the earlier assertion, and it
    // survived swapping the columns, dropping `mode: 'insensitive'` and turning `contains` into
    // `equals` — three ways to break a search while the test stayed green.
    //
    // Department and job title are in the list although the URL has no parameter for either: «кто у
    // нас на бэкенде» is a search, not a facet.
    const predicates = (argsOf(recorder, 'user.count')['where'] as { OR: unknown[] }).OR;
    const insensitive = { contains: 'ив', mode: 'insensitive' };

    expect(predicates).toEqual([
      { email: insensitive },
      { employeeProfile: { firstName: insensitive } },
      { employeeProfile: { lastName: insensitive } },
      { employeeProfile: { jobTitle: insensitive } },
      { employeeProfile: { department: insensitive } },
    ]);
  });

  it('asks for a role or a team by membership, not by a column on the person', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) =>
      repository.list({ ...baseFilter, roleIds: ['r-1'], teamIds: ['t-1'] }),
    );

    expect(argsOf(recorder, 'user.count')['where']).toMatchObject({
      roles: { some: { roleId: { in: ['r-1'] } } },
      teamMemberships: { some: { teamId: { in: ['t-1'] } } },
    });
  });

  it('leaves the filter out entirely when nothing was selected', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.list(baseFilter));

    // An empty `in` list matches nothing in SQL, so an unselected filter has to be **absent** rather
    // than empty — the difference between «any role» and «no rows at all».
    expect(argsOf(recorder, 'user.count')['where']).not.toHaveProperty('roles');
  });
});

describe('what a row is made of', () => {
  it('reads the personnel record when there is one', async () => {
    const recorder = recordingClient(1, true);

    const page = await inScope(recorder, (repository) => repository.list(baseFilter));

    expect(page.items[0]).toMatchObject({
      firstName: 'Ivan',
      lastName: 'Petrov',
      jobTitle: 'Backend engineer',
      managerId: 'boss',
      employmentType: 'PART_TIME',
      weeklyCapacityHours: 20,
      roles: [{ id: 'r-1', key: 'developer', name: 'Developer' }],
      teams: [{ id: 't-1', name: 'Platform' }],
    });
  });

  it('answers empty rather than absent for an account nobody has filled in yet', async () => {
    // The person exists, has an e-mail and a status. `null` employment says «nothing filled in»,
    // which is a different fact from «you may not see this» — that one is decided a layer up and
    // shows as the field not being in the response at all.
    const recorder = recordingClient(1, false);

    const page = await inScope(recorder, (repository) => repository.list(baseFilter));

    expect(page.items[0]).toMatchObject({
      firstName: '',
      lastName: '',
      jobTitle: null,
      employmentType: null,
      hiredAt: null,
      weeklyCapacityHours: null,
    });
  });

  it.each([
    ['-name', [{ employeeProfile: { lastName: 'desc' } }, { email: 'desc' }]],
    ['hiredAt', [{ employeeProfile: { hiredAt: 'asc' } }, { email: 'asc' }]],
    ['-hiredAt', [{ employeeProfile: { hiredAt: 'desc' } }, { email: 'asc' }]],
  ] as const)('orders by %s with a tie-breaker', async (sort, expected) => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.list({ ...baseFilter, sort }));

    expect(argsOf(recorder, 'user.findMany')['orderBy']).toEqual(expected);
  });
});

describe('the values the filters can take', () => {
  it('asks the roles and teams themselves, not the assignments', async () => {
    const recorder = recordingClient();

    const facets = await inScope(recorder, (repository) => repository.facets());

    // «Somebody holds this» as a predicate — `some` compiles to `EXISTS`. Asking the assignments
    // with a `distinct` on top reads every row of them: Prisma's `distinct` is post-processing in
    // the query engine, not a SQL `DISTINCT`, and the push-down it can do is skipped for an ordered
    // query. That is the difference between ten rows and every assignment in the organization, on
    // every page and every debounced keystroke.
    expect(recorder.calls.map((call) => call.name)).toEqual(['role.findMany', 'team.findMany']);
    expect(facets).toEqual({
      roles: [{ id: 'r-1', key: 'developer', name: 'Developer' }],
      teams: [{ id: 't-1', name: 'Platform' }],
    });
  });

  it('ignores a role nobody holds, a deleted team and the roles of deleted accounts', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.facets());

    expect(argsOf(recorder, 'role.findMany')['where']).toEqual({
      organizationId: ORG,
      holders: { some: { user: { deletedAt: null } } },
    });
    expect(argsOf(recorder, 'team.findMany')['where']).toEqual({
      organizationId: ORG,
      deletedAt: null,
      members: { some: { user: { deletedAt: null } } },
    });
  });
});

describe('the org chart', () => {
  it('reads every node in one statement, from the accounts', async () => {
    const recorder = recordingClient();

    const nodes = await inScope(recorder, (repository) => repository.orgChart());

    // From `users`, like the directory: reading the personnel records instead would put somebody who
    // accepted an invitation this morning in the table and leave them off the chart of the same
    // people.
    expect(recorder.calls.map((call) => call.name)).toEqual(['user.findMany']);
    expect(nodes).toEqual([
      { userId: 'user-0', firstName: '', lastName: '', jobTitle: null, managerId: null },
    ]);
  });

  it('carries the names of somebody whose record is filled in', async () => {
    const recorder = recordingClient(1, true);

    const nodes = await inScope(recorder, (repository) => repository.orgChart());

    expect(nodes[0]).toMatchObject({ firstName: 'Ivan', lastName: 'Petrov', managerId: 'boss' });
  });
});
