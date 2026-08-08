import { apiClient, unwrapApiResult, type components, type operations } from '@shared/api';

/**
 * The personnel record of one person.
 *
 * The type is the contract's, so the client cannot believe in a field the server does not send —
 * and the server sends **different shapes to different audiences**: a caller without
 * `employee:view_personal_data` receives no employment keys at all. The optional properties below
 * are that, expressed in the type system rather than in a comment.
 */
export type EmployeeProfile = components['schemas']['EmployeeProfile'];

/** What an edit carries. A PATCH: absent means «leave it», `null` means «clear it». */
export type EmployeeProfilePatch = components['schemas']['EmployeeProfilePatch'];

/** The signal is required, not optional: this is a query, and a query is always cancellable. */
export const fetchEmployeeProfile = async (
  userId: string,
  signal: AbortSignal,
): Promise<EmployeeProfile> =>
  unwrapApiResult(
    await apiClient.GET('/employees/{userId}', { params: { path: { userId } }, signal }),
  );

/** No signal: issued by pressing Save, so there is no later request that could overtake it. */
export const updateEmployeeProfile = async (
  userId: string,
  patch: EmployeeProfilePatch,
): Promise<EmployeeProfile> =>
  unwrapApiResult(
    await apiClient.PATCH('/employees/{userId}', { params: { path: { userId } }, body: patch }),
  );

/** One page of the directory, with the values its own filters can take. */
export type EmployeeDirectoryPage = components['schemas']['EmployeeDirectoryPage'];

export type EmployeeListItem = components['schemas']['EmployeeListItem'];

export type OrgChartNode = components['schemas']['OrgChartNode'];

/**
 * What the screen narrows the directory by.
 *
 * The element types come from the generated operation rather than from `string`, so a status or an
 * order the endpoint does not accept is a compile error at the call site instead of a 422 somebody
 * finds by clicking. Every field is present: the URL schema fills them all in, and «absent or the
 * thing I would have done anyway» is a branch nobody can see going wrong.
 */
type DirectoryQuery = NonNullable<operations['listEmployees']['parameters']['query']>;

export type EmployeeStatus = NonNullable<DirectoryQuery['status']>[number];
export type EmployeeSort = NonNullable<DirectoryQuery['sort']>;

export interface EmployeeListParams {
  readonly q: string;
  readonly status: readonly EmployeeStatus[];
  readonly role: readonly string[];
  readonly team: readonly string[];
  readonly sort: EmployeeSort;
  readonly page: number;
  readonly perPage: number;
}

/**
 * A page of the directory.
 *
 * The empty filters are sent as empty arrays rather than omitted: `openapi-fetch` serialises an
 * empty array to nothing at all, which is what «no filter» means here — and writing the branch at
 * the call site instead would put «is this array empty» in two places.
 */
export const fetchEmployeeList = async (
  params: EmployeeListParams,
  signal: AbortSignal,
): Promise<EmployeeDirectoryPage> =>
  unwrapApiResult(
    await apiClient.GET('/employees', {
      params: {
        query: {
          q: params.q,
          status: [...params.status],
          role: [...params.role],
          team: [...params.team],
          sort: params.sort,
          page: params.page,
          perPage: params.perPage,
        },
      },
      signal,
    }),
  );

export const fetchOrgChart = async (signal: AbortSignal): Promise<readonly OrgChartNode[]> =>
  unwrapApiResult(await apiClient.GET('/employees/org-chart', { signal })).nodes;
