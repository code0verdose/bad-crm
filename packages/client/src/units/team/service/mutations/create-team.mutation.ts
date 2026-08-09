import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { createTeam, type Team, type TeamDraft } from '@units/team/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

/** One id for the whole operation, so a second team does not stack a twin toast. */
const NOTIFICATION_ID = 'team-created';

/**
 * Creates a team — **pessimistically**, as `rules/tanstack-query.mdc` §7 requires of a create.
 *
 * An optimistic row would have to invent an id, and a row whose link leads nowhere is worse than a
 * moment without a row. The whole list is invalidated rather than patched, because the answer's
 * place in it depends on the order the screen is sorted by.
 *
 * **The local `onError` is what makes the dialog's own message the only signal.** `MutationCache`
 * skips a mutation that handles its failure itself (`rules/tanstack-query.mdc` §10), and the handling
 * here is a render: the dialog reads `mutation.error` and shows the refusal in place. It has to,
 * because that dialog is `aria-modal="true"` — while it is open, a toast in the corner of the page
 * is outside the accessibility tree a screen reader is confined to, so a toast alone would be a
 * refusal that a reader is never told about. `logError` still runs on every failure, shown or not.
 */
export const useCreateTeam = (): UseMutationResult<Team, Error, TeamDraft> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draft: TeamDraft) => createTeam(draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Teams.all });
      notify.success({ id: NOTIFICATION_ID, messageKey: 'teams.created' });
    },
    onError: () => undefined,
  });
};
