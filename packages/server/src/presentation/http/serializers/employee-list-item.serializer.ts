import {
  type OrgChartNode,
  type DirectoryRole,
  type DirectoryTeam,
} from '@/application/iam/ports/employee-directory-repository.port.js';
import {
  type VisibleDirectoryPage,
  type VisibleDirectoryRow,
} from '@/application/iam/use-cases/list-employees.query.js';

/**
 * A directory row on the wire, in the two shapes one row can take.
 *
 * **Built, never trimmed** — the same construction the single-profile serializer uses, and for the
 * same reason: a field a caller may not see is never assigned, so there is nowhere to forget a
 * `delete`. The difference here is that the decision is per **row**: a person reading the directory
 * sees the employment half of their own line and not of their colleagues', because that is what
 * `profileAudience` answers about each subject.
 *
 * **No key begins with `cost`.** Rates live in their own table with their own permission (M6), and
 * `test/unit/http/employee-list-serializer.test.ts` asserts the absence for every level — including
 * for a caller holding every employee capability there is.
 */

/** What any colleague sees: who this is, how to reach them, and where they sit. */
export interface PublicEmployeeListItem {
  readonly userId: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly jobTitle: string | null;
  readonly department: string | null;
  readonly status: string;
  readonly managerId: string | null;
  readonly roles: readonly DirectoryRole[];
  readonly teams: readonly DirectoryTeam[];
}

/** Additionally, for the person themselves and for HR: the employment. */
export interface PersonalEmployeeListItem extends PublicEmployeeListItem {
  readonly employmentType: string | null;
  readonly hiredAt: string | null;
  readonly terminatedAt: string | null;
  readonly weeklyCapacityHours: number | null;
}

export type EmployeeListItem = PublicEmployeeListItem | PersonalEmployeeListItem;

export interface EmployeeListResponse {
  readonly items: readonly EmployeeListItem[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly sort: string;
  readonly facets: {
    readonly roles: readonly DirectoryRole[];
    readonly teams: readonly DirectoryTeam[];
  };
}

/** A date, not an instant: nobody is hired at 14:32, and an ISO instant renders as the day before. */
const asDate = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

const serializeItem = (visible: VisibleDirectoryRow): EmployeeListItem => {
  const { row } = visible;
  const publicShape: PublicEmployeeListItem = {
    userId: row.userId,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    jobTitle: row.jobTitle,
    department: row.department,
    status: row.status,
    managerId: row.managerId,
    roles: row.roles,
    teams: row.teams,
  };

  if (!visible.audience.personal) return publicShape;

  return {
    ...publicShape,
    employmentType: row.employmentType,
    hiredAt: asDate(row.hiredAt),
    terminatedAt: asDate(row.terminatedAt),
    weeklyCapacityHours: row.weeklyCapacityHours,
  };
};

export const serializeEmployeeList = (page: VisibleDirectoryPage): EmployeeListResponse => ({
  items: page.items.map(serializeItem),
  total: page.total,
  page: page.page,
  perPage: page.perPage,
  // What the answer **is** ordered by, which the query may have downgraded — a control claiming an
  // order the rows are not in is a lie the reader discovers by counting.
  sort: page.sort,
  facets: page.facets,
});

export interface OrgChartResponse {
  readonly nodes: readonly OrgChartNode[];
}

/** Names and edges. Nothing of the employment half rides along on a chart. */
export const serializeOrgChart = (nodes: readonly OrgChartNode[]): OrgChartResponse => ({
  nodes: nodes.map((node) => ({
    userId: node.userId,
    firstName: node.firstName,
    lastName: node.lastName,
    jobTitle: node.jobTitle,
    managerId: node.managerId,
  })),
});
