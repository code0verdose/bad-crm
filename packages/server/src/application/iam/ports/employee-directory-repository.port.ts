/**
 * The directory: every account of the tenant, as a screen reads them.
 *
 * A read model rather than the profile aggregate, and it has its own port for that reason. What a
 * row needs — the account, the personnel record that may not exist yet, the roles, the teams — comes
 * from four tables, and none of them is the entity `EmployeeProfileRepositoryPort` writes.
 *
 * **The base table is `users`, not `employee_profiles`.** Somebody who accepted an invitation this
 * morning has an account and no personnel row, and a directory that started from the profiles would
 * leave them out of the list of the people who work here — which is the one thing this screen is for.
 *
 * No method takes an `organizationId`: the tenant is the scope the caller opened through
 * `UnitOfWorkPort` (`rules/tenancy-rls.mdc`, 9).
 */

/** A role as a row shows it. `key` is what a filter matches; `name` is what a person reads. */
export interface DirectoryRole {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

export interface DirectoryTeam {
  readonly id: string;
  readonly name: string;
}

/**
 * The account statuses a directory row can carry — the `UserStatus` enum of the schema, restated.
 *
 * A tuple rather than a type alias, because the validator needs the **values** to accept a query
 * parameter and a type alone cannot be iterated. Restated rather than imported from the generated
 * Prisma client, because `application` does not depend on the driver
 * (`rules/hexagonal-backend.mdc`); `test/unit/persistence/tenant-tables.test.ts` compares this list
 * against the `UserStatus` enum of the datamodel, so the restatement cannot drift in silence.
 */
export const DIRECTORY_STATUSES = ['ACTIVE', 'SUSPENDED', 'INVITED'] as const;

export type DirectoryStatus = (typeof DIRECTORY_STATUSES)[number];

/**
 * How a page is ordered.
 *
 * `hiredAt` is deliberately in the same closed list as `name` rather than being free-form: an order
 * is a question about a column, and ordering by a column a caller may not **read** is a side channel
 * — page through a directory sorted by hiring date and you have learnt everybody's, one comparison
 * at a time. `ListEmployeesQuery` refuses the employment orders to a caller who cannot see the
 * values, which is why the two kinds are named apart here.
 */
export const EMPLOYMENT_SORTS = ['hiredAt', '-hiredAt'] as const;
export const DIRECTORY_SORTS = ['name', '-name', ...EMPLOYMENT_SORTS] as const;

export type DirectorySort = (typeof DIRECTORY_SORTS)[number];

export interface EmployeeDirectoryFilter {
  /** Trimmed; empty means «no text filter». Matched against name, e-mail, job title and department. */
  readonly query: string;
  /** Empty means the default of the screen, which the query — not the repository — decides. */
  readonly statuses: readonly DirectoryStatus[];
  readonly roleIds: readonly string[];
  readonly teamIds: readonly string[];
  readonly sort: DirectorySort;
  /** One-based, as the URL carries it and a person reads it. */
  readonly page: number;
  readonly perPage: number;
}

/**
 * One person in the directory.
 *
 * The employment fields are read for everybody and **folded away per row** by the serializer, the
 * way one profile is (STORY-012-03): which audiences a caller belongs to is decided by
 * `profileAudience`, per subject rather than per request, because a person's own row is theirs to
 * read even when their colleagues' rows are not.
 *
 * They are nullable here for a different reason than «hidden»: an account with no personnel row yet
 * has no employment at all, and `null` is that fact rather than a permission.
 */
export interface EmployeeDirectoryRow {
  readonly userId: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly jobTitle: string | null;
  readonly department: string | null;
  readonly status: DirectoryStatus;
  readonly managerId: string | null;
  readonly roles: readonly DirectoryRole[];
  readonly teams: readonly DirectoryTeam[];
  readonly employmentType: string | null;
  readonly hiredAt: Date | null;
  readonly terminatedAt: Date | null;
  readonly weeklyCapacityHours: number | null;
}

/**
 * The values the filters can actually take **in this organization**.
 *
 * Part of this answer rather than a call to the role and team endpoints, and the reason differs per
 * facet. **Roles:** listing them needs `role:read`, which stops at `manager`
 * (`permission-model.md` §4.2) while the directory is open to `lead`, `developer` and `viewer` — a
 * screen that could list people but not name the roles it lists would have a filter with no options
 * in it. **Teams:** `team:read` is granted to everybody but `guest` (§4.1), so the capability is not
 * the obstacle — there is simply no endpoint to ask yet, because team management is STORY-012-07.
 * When it lands, this stays: a facet is «which values match somebody here», not «which exist».
 *
 * Only what somebody actually holds appears: a filter offering a value that matches nobody is a
 * dead end the reader has to walk into to discover.
 */
export interface DirectoryFacets {
  readonly roles: readonly DirectoryRole[];
  readonly teams: readonly DirectoryTeam[];
}

export interface EmployeeDirectoryPage {
  readonly items: readonly EmployeeDirectoryRow[];
  /** Rows matching the same predicate, before pagination — the number the pager shows. */
  readonly total: number;
}

/** A node of the org chart. Flat: the tree is assembled from `managerId` by whoever draws it. */
export interface OrgChartNode {
  readonly userId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly jobTitle: string | null;
  readonly managerId: string | null;
}

export interface EmployeeDirectoryRepositoryPort {
  list(filter: EmployeeDirectoryFilter): Promise<EmployeeDirectoryPage>;

  facets(): Promise<DirectoryFacets>;

  /**
   * Every node of the chart, in one query.
   *
   * The whole organization rather than a subtree, and flat rather than nested: the screen draws the
   * chart, so it needs all of it, and a `WITH RECURSIVE` would return the same rows at the cost of a
   * query that cannot be read. It would earn its keep the day somebody asks for «the branch under
   * Ivan» — that is a different question, and it does not exist yet.
   */
  orgChart(): Promise<readonly OrgChartNode[]>;
}
