import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { removeProjectMember } from '@units/project/api';
import { projectRefusalNotification } from '@units/project/lib';
import { rollbackOptimistic, runOptimisticRemove, type OptimisticContext } from '@shared/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

import { ROSTER_FAILURE_NOTIFICATION_ID } from './add-project-member.mutation.js';

export interface RemoveProjectMemberInput {
  readonly projectId: string;
  readonly userId: string;
}

/**
 * Taking somebody off a project — **optimistically**, as the delete `rules/tanstack-query.mdc` §6
 * names: the row leaves the roster at once, and comes back **to the place it had** if the server
 * refuses (the snapshot is restored, not the row re-appended).
 *
 * The refusal that really happens is the only lead (`409 last_project_lead_required`); it reads
 * «appoint another lead first», which is the next step the story asks the interface to offer
 * (STORY-014-02, acceptance 7). One toast, from the local `onError`, which replaces the global one.
 */
export const useRemoveProjectMember = (): UseMutationResult<
  void,
  Error,
  RemoveProjectMemberInput,
  OptimisticContext
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: RemoveProjectMemberInput) =>
      removeProjectMember(input.projectId, input.userId),
    onMutate: (input) =>
      runOptimisticRemove(queryClient, {
        queryKeys: [QueryKeys.Projects.members(input.projectId)],
        itemId: input.userId,
        idKey: 'userId',
      }),
    onError: (error, _input, context) => {
      rollbackOptimistic(queryClient, context);

      notify.error(projectRefusalNotification(ROSTER_FAILURE_NOTIFICATION_ID, error));
    },
    onSuccess: () => {
      notify.success({ id: 'project-member-removed', messageKey: 'projects.members.removed' });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: QueryKeys.Projects.all }),
  });
};
