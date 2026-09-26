import { apiClient, unwrapApiResult, type components, type operations } from '@shared/api';

/**
 * One project, as the card reads it (`GET /projects/{projectId}`, `project:read`).
 *
 * What the contract does **not** carry is as much a part of this type as what it does: no
 * `permissions` block yet (`{ canEdit, canManageMembers, canArchive }` is promised by STORY-014-05
 * acceptance 5 and is not in `docs/api/openapi.yaml`), and no financial field ever — a caller
 * without `project:view_budget` must not receive the keys at all (`T-PROJ-05`).
 */
export type ProjectDetail = components['schemas']['ProjectDetail'];

/** One membership: a user id and no name — who the account belongs to is `GET /employees`. */
export type ProjectMember = components['schemas']['ProjectMember'];

/** The signal is required, not optional: this is a query, and a query is always cancellable. */
export const fetchProject = async (
  projectId: string,
  signal: AbortSignal,
): Promise<ProjectDetail> =>
  unwrapApiResult(
    await apiClient.GET('/projects/{projectId}', { params: { path: { projectId } }, signal }),
  );

/** The live roster in joining order. People who left are not asked for: the card shows who is on it. */
export const fetchProjectMembers = async (
  projectId: string,
  signal: AbortSignal,
): Promise<readonly ProjectMember[]> =>
  unwrapApiResult(
    await apiClient.GET('/projects/{projectId}/members', {
      params: { path: { projectId } },
      signal,
    }),
  ).items;

/** One page of `GET /projects`, with the values its own filters can take. */
export type ProjectListPage = components['schemas']['ProjectListPage'];

/** One project as the list shows it — no description, no dates, no financial field (`T-PROJ-05`). */
export type ProjectListItem = components['schemas']['ProjectListItem'];

type ProjectListQuery = NonNullable<operations['listProjects']['parameters']['query']>;

export type ProjectListStatus = NonNullable<ProjectListQuery['status']>[number];
export type ProjectListSortParam = NonNullable<ProjectListQuery['sort']>;

/**
 * What the list screen asks for. Every field is present — `null` for «no such filter» — because the
 * same object is the query key, and a key is hashed as JSON, where `undefined` vanishes.
 */
export interface ProjectListParams {
  readonly q: string | null;
  readonly status: readonly ProjectListStatus[];
  readonly lead: string | null;
  readonly member: 'me' | null;
  readonly sort: ProjectListSortParam;
  readonly page: number;
  readonly perPage: number;
}

/**
 * A page of the projects this caller can see.
 *
 * An absent filter is **left out** of the query string, not sent empty: `lead=` is not a uuid and
 * the server answers it 422. `status` repeats the key (`?status=ACTIVE&status=ON_HOLD`), which is
 * how `openapi-fetch` writes an array; an empty array writes nothing, which is what «the server's
 * default — everything but the archive» means.
 */
export const fetchProjectList = async (
  params: ProjectListParams,
  signal: AbortSignal,
): Promise<ProjectListPage> =>
  unwrapApiResult(
    await apiClient.GET('/projects', {
      params: {
        query: {
          ...(params.q === null ? {} : { q: params.q }),
          status: [...params.status],
          ...(params.lead === null ? {} : { lead: params.lead }),
          ...(params.member === null ? {} : { member: params.member }),
          sort: params.sort,
          page: params.page,
          perPage: params.perPage,
        },
      },
      signal,
    }),
  );
