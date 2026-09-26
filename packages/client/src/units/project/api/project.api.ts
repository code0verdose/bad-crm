import { apiClient, unwrapApiResult, type components } from '@shared/api';

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
