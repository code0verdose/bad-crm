import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { revokeInvitation } from '@units/iam/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

/** One id for the whole operation, so a second run updates the toast instead of stacking one. */
const NOTIFICATION_ID = 'invitation-revoked';

/**
 * Closes an invitation — **pessimistically**, and deliberately not optimistically.
 *
 * Removing the row on `onMutate` would look right and hide the two answers that make this operation
 * worth confirming: `404 invitation_not_found` (somebody else closed it, or it never existed) and
 * `409 invitation_already_accepted` (it is a person now, and taking their access away is
 * deactivation, not this). Both would flash the row away and put it back — an interface changing its
 * mind about whether a colleague was invited.
 *
 * The undo-toast shape of `rules/errors-and-toasts.mdc` §9 does not apply either: there is nothing
 * to undo. The row is deleted and the token is dead, which is precisely why the screen asks first.
 *
 * One signal: a green toast on success, and no banner beside it. The refusal is rendered inside the
 * dialog — see the local `onError`.
 */
export const useRevokeInvitation = (): UseMutationResult<void, Error, string> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (invitationId: string) => revokeInvitation(invitationId),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Invitations.all });
      notify.success({ id: NOTIFICATION_ID, messageKey: 'members.invitations.revoked' });
    },

    /**
     * Declared so the global toast stands aside, and for nothing else — the same override as the
     * re-issue next door (`rules/tanstack-query.mdc` §10). The dialog that asked for the
     * confirmation is `aria-modal="true"`, so a toast outside it is, for a screen-reader user, no
     * signal at all; the sentence is rendered where the button was pressed.
     */
    onError: () => undefined,
  });
};
