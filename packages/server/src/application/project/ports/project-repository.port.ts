import { type ProjectScope, type ProjectSummary } from '@/domain/project/project.entity.js';
import { type ProjectStatus, type ProjectVisibility } from '@/domain/project/project.enums.js';

/**
 * What a project is created from, as the write path states it.
 *
 * `key` is already normalized here — upper-case, trimmed, `^[A-Z][A-Z0-9]{1,9}$`: the value object
 * of STORY-014-01 does that, and `ck_projects_key_format` refuses anything else so a raw write
 * cannot skip it. `status` is not on the draft: a project is born `ACTIVE` and changes status through
 * `changeStatus`, never through creation.
 */
export interface ProjectDraft {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly visibility: ProjectVisibility;
  readonly leadId: string;
  readonly startedAt: Date | null;
  readonly dueAt: Date | null;
  readonly color: string;
}

/**
 * The editable fields, replaced as a whole.
 *
 * `key` is absent on purpose: it is part of every task number (`BAD-14`), and changing it would
 * break every reference (STORY-014-01, acceptance 4). `visibility` and `status` are absent because
 * each is a decision of its own with its own permission and its own audit action.
 */
export interface ProjectPatch {
  readonly name: string;
  readonly description: string | null;
  readonly leadId: string;
  readonly startedAt: Date | null;
  readonly dueAt: Date | null;
  readonly color: string;
}

/** One row of the project list. */
export interface ProjectListEntry {
  readonly projectId: string;
  readonly key: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly visibility: ProjectVisibility;
  readonly leadId: string;
  readonly color: string;
  /** Live memberships only — people who left are not on the team. */
  readonly memberCount: number;
}

/**
 * One project, as the detail screen reads it.
 *
 * It carries `isDeleted` and is therefore a `ProjectScope`: like `TeamDetail`, the read by id does
 * **not** filter soft-deleted rows in SQL. The list must filter — a deleted project is not a
 * project. A read addressed by id must not, or «this row is deleted» would be decided by a `WHERE`
 * clause instead of by the policy, and the 404 it answers would be unreachable and untestable.
 */
export interface ProjectDetail extends ProjectListEntry, ProjectScope {
  readonly description: string | null;
  readonly startedAt: Date | null;
  readonly dueAt: Date | null;
  readonly taskCounter: number;
  readonly createdAt: Date;
}

/**
 * Projects, without their membership — that is `ProjectMemberRepositoryPort`, because the two
 * tables answer different questions and the membership half is what the access policy reads on
 * every request.
 *
 * No method takes an `organizationId`, and none takes a transaction: both come from the scope
 * `withTenant` opened. A parameter beside it would be a second source of truth about which
 * organization the caller is in — one that does not fail loudly when it disagrees, because a
 * mismatch is *filtered* by the policy rather than refused (`rules/tenancy-rls.mdc`, «Ловушки», 3).
 *
 * The soft-deletion filter is explicit in every method that lists and absent from every method that
 * reads by id. `data-model.md` («Мягкое удаление») asks for a global Prisma `$extends`; the tree has
 * none — the only `$extends` is the tenant guard — so the filter lives here and the unit test holds
 * it in place.
 */
export interface ProjectRepositoryPort {
  /** Every live project of the organization, ordered by key. */
  list(): Promise<readonly ProjectListEntry[]>;

  /**
   * The facts a decision needs, or `null` when the tenant's policy returns no row.
   *
   * Soft-deleted rows are returned flagged, not filtered. Read under `FOR SHARE`, held for the rest
   * of the transaction: a membership written later on the strength of this answer must not land on a
   * project a concurrent request has meanwhile deleted.
   */
  scope(projectId: string): Promise<ProjectScope | null>;

  /**
   * The same facts plus every editable field, read under **`FOR UPDATE`** — the read every mutation
   * of the row starts from, and the only one it may start from.
   *
   * Not `scope()`: that lock is `FOR SHARE`, and a writer that took it and then ran its `UPDATE`
   * would upgrade a share lock while a second writer holds the same share lock — two edits of one
   * project then deadlock, each waiting for the other's share to go away before its own upgrade
   * can proceed (the gate's note on step 3; `test/integration/db/project-write-locks.test.ts`
   * measures both shapes). `FOR UPDATE` from the first statement serializes writers instead.
   *
   * Flagged rather than filtered, like `scope()`: the policy decides what a deleted row answers.
   * The row is also the audit `before` of every change, which is why it carries the fields and not
   * only the scope.
   */
  lockForWrite(projectId: string): Promise<ProjectSummary | null>;

  detail(projectId: string): Promise<ProjectDetail | null>;

  /** `ConflictError('project_already_exists')` when the key is held by a live project. */
  create(draft: ProjectDraft): Promise<string>;

  /** `false` when there was no live row to update — deleted meanwhile, or never this tenant's. */
  update(projectId: string, patch: ProjectPatch): Promise<boolean>;

  changeVisibility(projectId: string, visibility: ProjectVisibility): Promise<boolean>;

  changeStatus(projectId: string, status: ProjectStatus): Promise<boolean>;

  /**
   * Hides the project, conditionally on it being live, stamped by the transaction clock.
   *
   * Memberships are left in place: a `project_members` row has `left_at` and is history by design,
   * and the project row itself survives for the same reason (`data-model.md`, «Мягкое удаление»).
   * `false` when there was nothing live to delete — the concurrent-delete window.
   */
  softDelete(projectId: string): Promise<boolean>;
}
