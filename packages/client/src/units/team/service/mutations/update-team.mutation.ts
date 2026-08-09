import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { updateTeam, type TeamDraft } from '@units/team/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

const NOTIFICATION_ID = 'team-saved';

export interface UpdateTeamInput {
  readonly teamId: string;
  readonly draft: TeamDraft;
}

/**
 * Renames a team, or moves its slug — **pessimistically**.
 *
 * `PATCH /teams/{teamId}` answers `204` and nothing else, so there is no document to write into the
 * cache: the group is invalidated instead, which is what the roster and the list rows both read.
 * Patching optimistically would also be patching the wrong thing — a rename can be refused for a
 * slug somebody else took a second ago, and rolling that back reads as the interface changing its
 * mind about what the team is called.
 *
 * **No local `onError`**: this form is on the page rather than in a modal, so the one global toast
 * keyed by `code` is both visible and the only signal (`rules/errors-and-toasts.mdc` §3).
 */
export const useUpdateTeam = (): UseMutationResult<void, Error, UpdateTeamInput> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateTeamInput) => updateTeam(input.teamId, input.draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Teams.all });
      notify.success({ id: NOTIFICATION_ID, messageKey: 'teams.saved' });
    },
  });
};
