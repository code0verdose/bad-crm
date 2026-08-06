import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { applyRoleChanges, type RoleChanges } from '@units/iam/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

export interface ApplyRoleChangesInput {
  readonly changes: RoleChanges;
  /** Set after the person has seen which arriving keys are dangerous and said so. */
  readonly confirmDangerous?: boolean;
}

/**
 * Saves the draft — pessimistically, and that is the whole point.
 *
 * An optimistic patch would show a matrix that the server may refuse in one of a dozen ways
 * (`system_role_immutable`, `self_lockout`, a key the author does not hold), and rolling back a
 * screenful of cells reads as the interface changing its mind. So the state moves when the server
 * says it moved, and the draft survives a refusal untouched — the person keeps their work and can
 * fix the one cell that was wrong.
 *
 * Both permission caches are invalidated: the roles themselves, and the caller's own rights, which
 * an edit to a role they hold has just changed.
 */
export const useApplyRoleChanges = (): UseMutationResult<void, Error, ApplyRoleChangesInput> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ApplyRoleChangesInput) =>
      applyRoleChanges(
        input.changes,
        input.confirmDangerous === true ? { confirmDangerous: true } : {},
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QueryKeys.Roles.all }),
        queryClient.invalidateQueries({ queryKey: QueryKeys.Permissions.all }),
      ]);
      // A stable id, so a person who saves twice gets one notification updated rather than two
      // stacked (`rules/errors-and-toasts.mdc` §2).
      notify.success({ id: 'admin-roles-saved', messageKey: 'roles.saved' });
    },
  });
};
