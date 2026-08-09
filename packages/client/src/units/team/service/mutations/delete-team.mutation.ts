import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { deleteTeam } from '@units/team/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

const NOTIFICATION_ID = 'team-deleted';

/**
 * Disbands a team — **pessimistically**, and deliberately not as an undoable toast.
 *
 * `rules/errors-and-toasts.mdc` §9 offers «Удалено» with an eight-second undo as one of the three
 * shapes a destructive action can take, and this is not it: the server removes every membership and
 * bumps every former member's permission version in the same transaction, so there is nothing an
 * undo could put back — the memberships are gone and the people have been re-authorised without
 * them. An affordance that cannot keep its promise is worse than the confirmation it replaced, so
 * the confirmation stays and the toast is a plain success.
 *
 * No optimistic removal for the same reason the create has none, plus one: the row would vanish from
 * a list the reader is not looking at, while the screen they *are* on is about to be left behind.
 *
 * **The local `onError` is what makes the dialog's own message the only signal** — the dialog is
 * `aria-modal="true"`, and a toast outside it is not in the accessibility tree a screen reader is
 * confined to (`rules/tanstack-query.mdc` §10).
 */
export const useDeleteTeam = (): UseMutationResult<void, Error, string> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (teamId: string) => deleteTeam(teamId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Teams.all });
      notify.success({ id: NOTIFICATION_ID, messageKey: 'teams.deleted' });
    },
    onError: () => undefined,
  });
};
