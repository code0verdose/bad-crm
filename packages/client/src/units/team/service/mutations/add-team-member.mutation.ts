import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { addTeamMember } from '@units/team/api';
import { type TeamRole } from '@units/team/model/enums/team-role.enums.js';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

export interface AddTeamMemberInput {
  readonly teamId: string;
  readonly userId: string;
  readonly teamRole: TeamRole;
}

/**
 * Putting somebody on a team — **pessimistically**, and that is a decision about what a membership
 * is rather than about the network.
 *
 * Membership is an input to `permissionsVersion`: the server bumps the person's version in the same
 * transaction, so the change applies on their next request rather than at their next sign-in. An
 * optimistic row would show somebody as being on the team before anything of the sort had happened
 * — and the refusals this endpoint really produces are exactly the cases where it never will:
 * `409 member_not_active` for a deactivated account, `404` for a team of another organization.
 *
 * The whole group is invalidated rather than the roster alone, because `memberCount` on the list is
 * the same fact seen from the other screen.
 *
 * **No local `onError`**: the control sits on the page rather than in a modal, so the one global
 * toast keyed by `code` is visible where the action was taken — `member_not_active` reads as
 * «reactivate them first», which is the whole sentence somebody needs.
 */
export const useAddTeamMember = (): UseMutationResult<void, Error, AddTeamMemberInput> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: AddTeamMemberInput) =>
      addTeamMember(input.teamId, { userId: input.userId, teamRole: input.teamRole }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Teams.all });
      notify.success({ id: 'team-member-added', messageKey: 'teams.members.added' });
    },
  });
};
