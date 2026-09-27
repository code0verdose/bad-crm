import { apiClient, idempotencyParams, unwrapApiResult, type components } from '@shared/api';

/**
 * One project, as the card reads it (`GET /projects/{projectId}`, `project:read`) — and as
 * `POST /projects` answers, which is the same schema.
 *
 * It carries the `permissions` block: which of the project's commands this caller would be let
 * through, decided by the server with the policy each command asserts. The card draws its controls
 * from that block and from nothing else — never from a role (invariant 2, risk R-15). What the
 * contract does **not** carry is as much a part of this type: no financial field ever — a caller
 * without `project:view_budget` must not receive the keys at all (`T-PROJ-05`).
 */
export type ProjectDetail = components['schemas']['ProjectDetail'];

/** `{ canEdit, canManageMembers, canArchive, canDelete }` — a hint for the controls, not a grant. */
export type ProjectPermissions = components['schemas']['ProjectPermissions'];

/** What a project is created from. `key` is normalized by the server and never changes afterwards. */
export type ProjectDraft = components['schemas']['ProjectDraft'];

/** The editable fields, replaced as a whole: no `key`, no `visibility`, no `status`. */
export type ProjectPatch = components['schemas']['ProjectPatch'];

/** One membership: a user id and no name — who the account belongs to is `GET /employees`. */
export type ProjectMember = components['schemas']['ProjectMember'];

export type ProjectMemberDraft = components['schemas']['ProjectMemberDraft'];

/** A field left out is left as it is; at least one is present. */
export type ProjectMemberPatch = components['schemas']['ProjectMemberPatch'];

export type ProjectVisibilityValue = components['schemas']['ProjectVisibilityChange']['visibility'];

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

/**
 * No `signal` on any of the writes below: each is issued by pressing a button, not by a changing
 * query key, so there is no later request that could overtake it.
 *
 * The idempotency key is minted at the call site where the contract marks the header `required`
 * (`POST /projects`, `POST …/members`) — the generated types demand it, which makes «I forgot the
 * header» a compile error instead of a duplicate project.
 */
export const createProject = async (draft: ProjectDraft): Promise<ProjectDetail> => {
  const { params } = idempotencyParams();

  return unwrapApiResult(await apiClient.POST('/projects', { body: draft, params }));
};

/** Replace, not merge: the body is what the project will be, and a missing description is cleared. */
export const updateProject = async (projectId: string, patch: ProjectPatch): Promise<void> => {
  unwrapApiResult(
    await apiClient.PATCH('/projects/{projectId}', {
      params: { path: { projectId } },
      body: patch,
    }),
  );
};

/**
 * Changes the visibility **with** `X-Confirm-Dangerous: 1`. Only ever called from the confirmation
 * dialog, after the consequences were shown — so the confirmation the header states has actually
 * been collected. Without it the contract answers `428 confirmation_required`, the step a client
 * that showed nothing would need. A header, never a body field, because the contract says so.
 */
export const changeProjectVisibility = async (
  projectId: string,
  visibility: ProjectVisibilityValue,
): Promise<void> => {
  unwrapApiResult(
    await apiClient.POST('/projects/{projectId}/visibility', {
      params: { path: { projectId }, header: { 'X-Confirm-Dangerous': '1' } },
      body: { visibility },
    }),
  );
};

/** `status` becomes `ARCHIVED`; idempotent — an archived project answers `204` again. */
export const archiveProject = async (projectId: string): Promise<void> => {
  unwrapApiResult(
    await apiClient.POST('/projects/{projectId}/archive', { params: { path: { projectId } } }),
  );
};

/** Soft: the project answers `404` by id afterwards, and its key is free again. */
export const deleteProject = async (projectId: string): Promise<void> => {
  unwrapApiResult(
    await apiClient.DELETE('/projects/{projectId}', { params: { path: { projectId } } }),
  );
};

/** A membership is access: the person's permission version is bumped in the same transaction. */
export const addProjectMember = async (
  projectId: string,
  draft: ProjectMemberDraft,
): Promise<void> => {
  const { params } = idempotencyParams();

  unwrapApiResult(
    await apiClient.POST('/projects/{projectId}/members', {
      params: { ...params, path: { projectId } },
      body: draft,
    }),
  );
};

export const updateProjectMember = async (
  projectId: string,
  userId: string,
  patch: ProjectMemberPatch,
): Promise<void> => {
  unwrapApiResult(
    await apiClient.PATCH('/projects/{projectId}/members/{userId}', {
      params: { path: { projectId, userId } },
      body: patch,
    }),
  );
};

/** The membership ends (`leftAt`), it does not disappear; the only lead is refused `409`. */
export const removeProjectMember = async (projectId: string, userId: string): Promise<void> => {
  unwrapApiResult(
    await apiClient.DELETE('/projects/{projectId}/members/{userId}', {
      params: { path: { projectId, userId } },
    }),
  );
};
