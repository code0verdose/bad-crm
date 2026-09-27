import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { addProjectMember, type ProjectMemberDraft } from '@units/project/api';
import { projectRefusalNotification } from '@units/project/lib';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

export interface AddProjectMemberInput {
  readonly projectId: string;
  readonly draft: ProjectMemberDraft;
}

/** One id for the refusals of every roster command, so a repeat updates rather than stacks. */
export const ROSTER_FAILURE_NOTIFICATION_ID = 'project-roster-failed';

/**
 * Putting somebody on a project — **pessimistically**, as a create (`rules/tanstack-query.mdc` §7),
 * and against the story's own plan («оптимистичный патч + rollback»), which predates the contract:
 * the endpoint answers `204` with no row, and the refusals it really produces — the reader themselves
 * (`self_assignment_forbidden`), a switched-off account (`member_not_active`) — are exactly the cases
 * where an optimistic row would show somebody holding access they never got.
 *
 * **A local `onError` that notifies**, rather than none: the global toast would translate the
 * collapsed `user_forbidden` code as «no access to this person», which is not what happened. The
 * precise sentence comes from the `reason` (`project-refusal.util.ts`). One toast either way.
 */
export const useAddProjectMember = (): UseMutationResult<void, Error, AddProjectMemberInput> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: AddProjectMemberInput) => addProjectMember(input.projectId, input.draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Projects.all });
      notify.success({ id: 'project-member-added', messageKey: 'projects.members.added' });
    },
    onError: (error) => {
      notify.error(projectRefusalNotification(ROSTER_FAILURE_NOTIFICATION_ID, error));
    },
  });
};
