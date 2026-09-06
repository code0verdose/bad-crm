import { type ProjectMembership, type ProjectSubject } from '@/domain/project/project.entity.js';
import { type ProjectRole } from '@/domain/project/project.enums.js';

/** One membership, as the roster screen reads it. */
export interface ProjectMemberEntry {
  readonly userId: string;
  readonly projectRole: ProjectRole;
  readonly allocationPct: number;
  readonly joinedAt: Date;
  /** `null` while the membership is live; the row stays after it ends (STORY-014-02, acceptance 5). */
  readonly leftAt: Date | null;
}

/** What a membership change may touch. A field that is absent is left as it is. */
export interface ProjectMemberPatch {
  readonly projectRole?: ProjectRole;
  readonly allocationPct?: number;
}

/**
 * The membership of projects.
 *
 * A membership **ends**, it is not deleted: `left_at` is stamped, the row stays as history and as a
 * link target, and the partial unique index `uq_project_members (project_id, user_id) WHERE left_at
 * IS NULL` is what lets the same person join again later as a new row. Every method that means
 * «the team» therefore reads live rows only, and `roster` shows the people who left on request.
 *
 * No method takes an `organizationId` or a transaction — both come from the scope `withTenant`
 * opened (`rules/tenancy-rls.mdc`, «Ловушки», 3).
 */
export interface ProjectMemberRepositoryPort {
  /** Live memberships in joining order; with `includeLeft`, every row the project ever had. */
  roster(
    projectId: string,
    options?: { readonly includeLeft?: boolean },
  ): Promise<readonly ProjectMemberEntry[]>;

  /** The live membership of one person, or `null`. The fact the implicit level derives from. */
  membershipOf(projectId: string, userId: string): Promise<ProjectMembership | null>;

  /**
   * The ids of the live `LEAD`s, read under `FOR UPDATE` and held for the rest of the transaction.
   *
   * «The last lead cannot leave» is the use-case's rule, and it is only sound if two concurrent
   * removals cannot both count two leads: the lock makes the second wait, and `READ COMMITTED`
   * re-evaluates `left_at IS NULL` on the row version the first one wrote.
   */
  leads(projectId: string): Promise<readonly string[]>;

  /** The account a membership would be written for, or `null` when this tenant cannot see it. */
  subject(userId: string): Promise<ProjectSubject | null>;

  /**
   * Writes one live membership; `false` when the pair already holds one.
   *
   * `INSERT … ON CONFLICT (project_id, user_id) WHERE left_at IS NULL DO NOTHING`: two concurrent
   * adds of the same pair leave one row and answer `true` exactly once. A repeat with a different
   * role is **not** a role change — that is `update`, with its own permission and audit action.
   */
  add(
    projectId: string,
    userId: string,
    projectRole: string,
    allocationPct: number,
  ): Promise<boolean>;

  /** `false` when there was no live membership to change. */
  update(projectId: string, userId: string, patch: ProjectMemberPatch): Promise<boolean>;

  /** Stamps `left_at` on the live row; `false` when there was none. */
  leave(projectId: string, userId: string): Promise<boolean>;
}
