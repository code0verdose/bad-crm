import { type Prisma } from '@prisma/client';

import {
  type DirectoryFacets,
  type DirectorySort,
  type DirectoryStatus,
  type EmployeeDirectoryFilter,
  type EmployeeDirectoryPage,
  type EmployeeDirectoryRepositoryPort,
  type EmployeeDirectoryRow,
  type OrgChartNode,
} from '@/application/iam/ports/employee-directory-repository.port.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

/**
 * The directory through Prisma, inside the scope the caller opened.
 *
 * **`users` is the base table**, with the personnel record joined as the optional thing it is:
 * somebody who accepted an invitation this morning has an account and no `employee_profiles` row,
 * and starting from the profiles would leave them out of the list of people who work here.
 *
 * **A page costs a fixed number of statements**, whatever the number of rows on it: one count, one
 * page, and one for each of the two relations Prisma loads separately. That is what the acceptance
 * criterion means by «no N+1», and `employee-directory-repository.test.ts` asserts it by comparing
 * the call count of a page of one row against a page of fifty.
 */
export class PrismaEmployeeDirectoryRepository
  extends TenantScopedRepository
  implements EmployeeDirectoryRepositoryPort
{
  protected readonly resource = 'user' as const;
  protected readonly repositoryName = 'EmployeeDirectoryRepository';

  list(filter: EmployeeDirectoryFilter): Promise<EmployeeDirectoryPage> {
    return this.run('list', async (tx) => {
      const where = this.whereOf(filter);

      // Counted with the same predicate the page uses, and inside the same transaction: a total
      // obtained separately is a total of a different moment, and a pager that promises rows the
      // next page does not have is worse than no pager.
      const total = await tx.user.count({ where });
      const accounts = await tx.user.findMany({
        where,
        orderBy: orderOf(filter.sort),
        skip: (filter.page - 1) * filter.perPage,
        take: filter.perPage,
        select: {
          id: true,
          email: true,
          status: true,
          employeeProfile: {
            select: {
              firstName: true,
              lastName: true,
              jobTitle: true,
              department: true,
              managerId: true,
              employmentType: true,
              hiredAt: true,
              terminatedAt: true,
              weeklyCapacityHours: true,
            },
          },
          roles: { select: { role: { select: { id: true, key: true, name: true } } } },
          teamMemberships: { select: { team: { select: { id: true, name: true } } } },
        },
      });

      return { items: accounts.map(toRow), total };
    });
  }

  facets(): Promise<DirectoryFacets> {
    return this.run('facets', async (tx) => {
      const organizationId = this.organizationId('facets');

      // Asked of the **roles and teams**, with «somebody holds this» as a predicate — not of the
      // assignments with a `distinct` on top. Prisma's `distinct` is not a SQL `DISTINCT`: without
      // the `nativeDistinct` preview flag it is post-processing in the query engine, and even with
      // it the push-down is skipped for an ordered query. So the earlier spelling read every
      // assignment and every membership of the organization on **each** page and each debounced
      // keystroke, to return ten roles. `some` compiles to `EXISTS`, which is the question actually
      // being asked: a filter offering a value that matches nobody is a dead end the reader has to
      // walk into to discover.
      const held = await tx.role.findMany({
        where: { organizationId, holders: { some: { user: { deletedAt: null } } } },
        select: { id: true, key: true, name: true },
        orderBy: { name: 'asc' },
      });
      const joined = await tx.team.findMany({
        where: {
          organizationId,
          deletedAt: null,
          members: { some: { user: { deletedAt: null } } },
        },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });

      return { roles: held, teams: joined };
    });
  }

  orgChart(): Promise<readonly OrgChartNode[]> {
    return this.run('orgChart', async (tx) => {
      // From `users`, like the directory, and for the same reason: somebody who accepted an
      // invitation this morning has an account and no personnel row. Reading the profiles would put
      // them in the table and leave them off the chart of the same people — two views of one
      // organization that disagree about who is in it.
      const accounts = await tx.user.findMany({
        where: { organizationId: this.organizationId('orgChart'), deletedAt: null },
        select: {
          id: true,
          email: true,
          employeeProfile: {
            select: { firstName: true, lastName: true, jobTitle: true, managerId: true },
          },
        },
        orderBy: [{ employeeProfile: { lastName: 'asc' } }, { email: 'asc' }],
      });

      return accounts.map((account) => ({
        userId: account.id,
        firstName: account.employeeProfile?.firstName ?? '',
        lastName: account.employeeProfile?.lastName ?? '',
        jobTitle: account.employeeProfile?.jobTitle ?? null,
        managerId: account.employeeProfile?.managerId ?? null,
      }));
    });
  }

  /**
   * The predicate, assembled once and used by both the count and the page.
   *
   * `deletedAt: null` is not one of the filters: a deleted account is not a state of a person the
   * directory shows, it is a row kept because other rows point at it.
   */
  private whereOf(filter: EmployeeDirectoryFilter): Prisma.UserWhereInput {
    return {
      // Read from the scope, not taken as an argument: a repository that accepted an organization
      // would have a second source of truth for the tenant, and a disagreement between the two is
      // not an error but an empty result (`rules/tenancy-rls.mdc` rule 9).
      organizationId: this.organizationId('list'),
      deletedAt: null,
      status: { in: filter.statuses as DirectoryStatus[] },
      ...(filter.query === '' ? {} : { OR: textPredicates(filter.query) }),
      ...(filter.roleIds.length === 0
        ? {}
        : { roles: { some: { roleId: { in: [...filter.roleIds] } } } }),
      ...(filter.teamIds.length === 0
        ? {}
        : { teamMemberships: { some: { teamId: { in: [...filter.teamIds] } } } }),
    };
  }
}

/**
 * Where the text of a search is looked for.
 *
 * Department and job title are in the list although the URL has no parameter for either: «кто у нас
 * на бэкенде» is a search, not a facet, and a screen that made it one would need a picker of every
 * free-text department somebody has ever typed.
 */
const textPredicates = (query: string): Prisma.UserWhereInput[] => [
  { email: { contains: query, mode: 'insensitive' } },
  { employeeProfile: { firstName: { contains: query, mode: 'insensitive' } } },
  { employeeProfile: { lastName: { contains: query, mode: 'insensitive' } } },
  { employeeProfile: { jobTitle: { contains: query, mode: 'insensitive' } } },
  { employeeProfile: { department: { contains: query, mode: 'insensitive' } } },
];

/**
 * The order, with a tie-breaker that is never null.
 *
 * Without the second key, two people with the same surname — or the many with none yet — come back
 * in whatever order the plan happens to produce, which means a row can appear on two consecutive
 * pages and another on neither. The e-mail is unique inside the organization, so it settles every
 * tie there can be.
 */
const orderOf = (sort: DirectorySort): Prisma.UserOrderByWithRelationInput[] => {
  switch (sort) {
    case '-name':
      return [{ employeeProfile: { lastName: 'desc' } }, { email: 'desc' }];
    case 'hiredAt':
      return [{ employeeProfile: { hiredAt: 'asc' } }, { email: 'asc' }];
    case '-hiredAt':
      return [{ employeeProfile: { hiredAt: 'desc' } }, { email: 'asc' }];
    default:
      return [{ employeeProfile: { lastName: 'asc' } }, { email: 'asc' }];
  }
};

interface AccountRow {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly employeeProfile: {
    readonly firstName: string;
    readonly lastName: string;
    readonly jobTitle: string | null;
    readonly department: string | null;
    readonly managerId: string | null;
    readonly employmentType: string;
    readonly hiredAt: Date | null;
    readonly terminatedAt: Date | null;
    readonly weeklyCapacityHours: number;
  } | null;
  readonly roles: readonly { readonly role: { id: string; key: string; name: string } }[];
  readonly teamMemberships: readonly { readonly team: { id: string; name: string } }[];
}

/**
 * An account and its personnel record as one row.
 *
 * A missing profile is empty strings and nulls rather than an absent row: the person exists, has an
 * e-mail and a status, and nobody has filled the rest in yet. `null` employment says exactly that —
 * it is not the same fact as «you may not see this», which is decided a layer up and expressed by
 * the field not being in the response at all.
 */
const toRow = (account: AccountRow): EmployeeDirectoryRow => ({
  userId: account.id,
  email: account.email,
  firstName: account.employeeProfile?.firstName ?? '',
  lastName: account.employeeProfile?.lastName ?? '',
  jobTitle: account.employeeProfile?.jobTitle ?? null,
  department: account.employeeProfile?.department ?? null,
  status: account.status as DirectoryStatus,
  managerId: account.employeeProfile?.managerId ?? null,
  roles: account.roles.map((entry) => entry.role),
  teams: account.teamMemberships.map((entry) => entry.team),
  employmentType: account.employeeProfile?.employmentType ?? null,
  hiredAt: account.employeeProfile?.hiredAt ?? null,
  terminatedAt: account.employeeProfile?.terminatedAt ?? null,
  weeklyCapacityHours: account.employeeProfile?.weeklyCapacityHours ?? null,
});
