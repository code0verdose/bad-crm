import { type ProjectPermissions } from '@units/project/api';
import { useProjectDetailQuery } from '@units/project/service/queries/project-detail.query.js';

export interface ProjectControls extends ProjectPermissions {
  /**
   * `ARCHIVED`: the controls the flags allow stay drawn and reachable, marked unavailable
   * (`aria-disabled`), with a note beside them saying why — and they do nothing.
   */
  readonly isArchived: boolean;
  /** Any of the settings commands is open to this reader — the settings section has something to show. */
  readonly hasSettings: boolean;
}

/**
 * Which of the project's controls to draw — read from the card's `permissions` block and from
 * nothing else (STORY-014-05, acceptance 5).
 *
 * **No role, no level, no table here.** Each flag is the server's decision for one command, made by
 * the same policy the command asserts over the same ACL chain (`ProjectPermissions` in the
 * contract). Recomputing any of them from a role on the client would be the second point of
 * computing rights that invariant 2 forbids (risk R-15). The flags are a hint: every command decides
 * again on its own request, and a flag gone stale between the read and the click is answered by that
 * command's `403`/`404`, which the screen reports in one toast or in its dialog.
 *
 * `isArchived` is not a right: the server's commands do not refuse an archived project today, and the
 * block does not pretend they do. It is the product rule of acceptance 7 — «изменяющие действия
 * отключены с объяснением» — applied by the screens that draw the controls.
 */
export const useProjectControls = (projectId: string): ProjectControls => {
  const { data: project } = useProjectDetailQuery(projectId);
  const { canEdit, canManageMembers, canChangeVisibility, canArchive, canDelete } =
    project.permissions;

  return {
    canEdit,
    canManageMembers,
    canChangeVisibility,
    canArchive,
    canDelete,
    isArchived: project.status === 'ARCHIVED',
    hasSettings: canEdit || canChangeVisibility || canArchive || canDelete,
  };
};
