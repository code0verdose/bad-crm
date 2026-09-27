import { useCallback } from 'react';

import { type ProjectRole } from '@units/project/model';
import { useAddProjectMember } from '@units/project/service/mutations/add-project-member.mutation.js';
import { useRemoveProjectMember } from '@units/project/service/mutations/remove-project-member.mutation.js';
import { useUpdateProjectMember } from '@units/project/service/mutations/update-project-member.mutation.js';

export interface ProjectRoster {
  /** Puts somebody on the project. `onAdded` fires only on success — the form clears then. */
  readonly add: (
    userId: string,
    projectRole: ProjectRole,
    allocationPct: number,
    onAdded: () => void,
  ) => void;
  readonly isAdding: boolean;
  /** Changes a member's role in place — the row shows the new role at once, and takes it back on refusal. */
  readonly changeRole: (userId: string, projectRole: ProjectRole) => void;
  /**
   * Takes somebody off — the row leaves at once, and returns to its place on refusal. `onRemoved`
   * fires only once the server has agreed: until then the row may still come back.
   */
  readonly remove: (userId: string, onRemoved: () => void) => void;
}

/**
 * The roster commands of one project — the unit's public API for the members section.
 *
 * Three mutations, three canons (`rules/tanstack-query.mdc` §6–§7): the add is a create and waits for
 * the server; the role select and the removal are the inline edit and the delete, and are applied
 * optimistically with the shared rollback. Which toasts appear, and that there is one per action, is
 * decided in the mutations, not here.
 */
export const useProjectRoster = (projectId: string): ProjectRoster => {
  const adding = useAddProjectMember();
  const updating = useUpdateProjectMember();
  const removing = useRemoveProjectMember();

  const add = useCallback(
    (userId: string, projectRole: ProjectRole, allocationPct: number, onAdded: () => void) => {
      adding.mutate(
        { projectId, draft: { userId, projectRole, allocationPct } },
        { onSuccess: onAdded },
      );
    },
    [adding.mutate, projectId],
  );

  const changeRole = useCallback(
    (userId: string, projectRole: ProjectRole) => {
      updating.mutate({ projectId, userId, patch: { projectRole } });
    },
    [updating.mutate, projectId],
  );

  const remove = useCallback(
    (userId: string, onRemoved: () => void) => {
      removing.mutate({ projectId, userId }, { onSuccess: onRemoved });
    },
    [removing.mutate, projectId],
  );

  return { add, isAdding: adding.isPending, changeRole, remove };
};
