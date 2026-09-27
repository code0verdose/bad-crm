import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import {
  updateProjectMember,
  type ProjectMember,
  type ProjectMemberPatch,
} from '@units/project/api';
import { projectRefusalNotification } from '@units/project/lib';
import { rollbackOptimistic, runOptimisticPatch, type OptimisticContext } from '@shared/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

import { ROSTER_FAILURE_NOTIFICATION_ID } from './add-project-member.mutation.js';

export interface UpdateProjectMemberInput {
  readonly projectId: string;
  readonly userId: string;
  readonly patch: ProjectMemberPatch;
}

/**
 * Changing somebody's role on a project from the roster row — **optimistically**, because this is
 * the inline edit `rules/tanstack-query.mdc` §6 names: one select in one row, where waiting for the
 * server is the whole cost of the interaction.
 *
 * The order is the rule's: `onMutate` patches the roster synchronously through the shared helper
 * (a membership is addressed by `userId`, hence `idKey`); `onError` restores the snapshot — the row
 * goes back to the role it had, in the place it had it — and says why, once, from the `reason`
 * (`last_project_lead_required` for the only lead, `self_assignment_forbidden` for one's own seat);
 * `onSettled` invalidates the group so the card's header and the roster end on the server's state.
 *
 * The local `onError` replaces the global toast rather than adding to it (§10).
 */
export const useUpdateProjectMember = (): UseMutationResult<
  void,
  Error,
  UpdateProjectMemberInput,
  OptimisticContext
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateProjectMemberInput) =>
      updateProjectMember(input.projectId, input.userId, input.patch),
    onMutate: (input) =>
      runOptimisticPatch<ProjectMember>(queryClient, {
        queryKeys: [QueryKeys.Projects.members(input.projectId)],
        itemId: input.userId,
        idKey: 'userId',
        patch: input.patch,
      }),
    onError: (error, _input, context) => {
      rollbackOptimistic(queryClient, context);

      notify.error(projectRefusalNotification(ROSTER_FAILURE_NOTIFICATION_ID, error));
    },
    onSuccess: () => {
      notify.success({ id: 'project-member-updated', messageKey: 'projects.members.updated' });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: QueryKeys.Projects.all }),
  });
};
