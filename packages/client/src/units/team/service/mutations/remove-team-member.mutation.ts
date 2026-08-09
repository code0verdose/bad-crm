import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { removeTeamMember } from '@units/team/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

export interface RemoveTeamMemberInput {
  readonly teamId: string;
  readonly userId: string;
}

/**
 * Taking somebody off a team — **pessimistically**.
 *
 * `rules/tanstack-query.mdc` §6 names delete among the optimistic candidates, and this one is
 * deliberately not one: a removal that appears to succeed and is then rolled back tells somebody
 * twice, in opposite directions, what a colleague's access now is. The roster is a handful of rows
 * and the answer is immediate, so the optimism buys nothing to weigh against that.
 *
 * A membership that was not there is `404` rather than a silent success, and the global toast says
 * so — the caller asked to remove something the organization does not have.
 */
export const useRemoveTeamMember = (): UseMutationResult<void, Error, RemoveTeamMemberInput> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: RemoveTeamMemberInput) => removeTeamMember(input.teamId, input.userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Teams.all });
      notify.success({ id: 'team-member-removed', messageKey: 'teams.members.removed' });
    },
  });
};
