import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { resendInvitation, type MintedInvitation } from '@units/iam/api';
import { QueryKeys } from '@shared/lib';

/**
 * Mints a new link for an invitation that already exists — **pessimistically**, because the answer
 * is the whole point of the operation.
 *
 * There is nothing to be optimistic about: the new token and the new expiry exist only in this
 * response, the server keeps a digest of the first and cannot produce it twice. A patched row would
 * therefore have to invent the one field the screen came here for, and it would also paper over the
 * refusal this operation really produces — `409 invitation_already_accepted`, which means the row is
 * a person now and the list is about to be one shorter.
 *
 * **No toast.** The signal is the panel with the link in it, which the screen has to show anyway
 * because it is the only copy that will ever exist; a toast beside it would be the second signal for
 * one action (`rules/errors-and-toasts.mdc` §2). The refusal is rendered inside the dialog that
 * asked for the confirmation, for the reason the local `onError` below states.
 *
 * `gcTime: 0` for the same reason as `useCreateInvitation`: the answer carries `inviteUrl`, the
 * whole credential for creating an account in this organization. Without it the link would sit in
 * the `MutationCache` for the default five minutes after the screen unmounted, reachable from
 * `self.__TSR_ROUTER__` by anything running on the page.
 */
export const useResendInvitation = (): UseMutationResult<MintedInvitation, Error, string> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (invitationId: string) => resendInvitation(invitationId),

    // The expiry moved, so the row on screen is stale — and if the server refused because the
    // invitation has just been accepted, the row should not be there at all.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Invitations.all });
    },

    /**
     * Declared so the global toast stands aside, and for nothing else.
     *
     * `MutationCache.onError` skips a mutation that handles its own failure, which is what makes a
     * local handler an override rather than an addition (`rules/tanstack-query.mdc` §10). The
     * handling is a **render**: the confirmation dialog is `aria-modal="true"`, so while it is open
     * a toast in the corner of the page is outside the accessibility tree its reader is confined to
     * — the same decision, for the same reason, as the offboarding dialog.
     *
     * Nothing to undo: the mutation is pessimistic, so no optimistic patch was applied. The log line
     * is not lost either — `logError` runs before this check, on every failure, shown or not.
     */
    onError: () => undefined,

    gcTime: 0,
  });
};
