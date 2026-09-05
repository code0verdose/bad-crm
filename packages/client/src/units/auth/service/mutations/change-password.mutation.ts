import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { changePassword, type ChangePasswordRequest } from '@units/auth/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

const NOTIFICATION_ID = 'password-changed';

/**
 * Replaces the caller's password — **pessimistically**, because there is nothing to show optimistically.
 *
 * **The session list is invalidated, and that is not housekeeping.** The operation closes every other
 * session in the same transaction, and on this screen the list of those sessions is a few hundred
 * pixels away. A screen that left it alone would go on showing devices that the person had just
 * signed out, which is worse than showing nothing: it says the action did not work.
 *
 * `revokedCount` is not in the answer — the operation is a 204 — so what is left is asking again.
 * Writing the emptied list locally would be a second answer to «which sessions are open», and the
 * one that is wrong whenever anything else happened in between.
 *
 * **The local `onError` is here for the same reason as its neighbours', with a different second
 * half.** Next door it silences the global toast because a dialog is `aria-modal="true"` and a toast
 * behind one reaches nobody; here there is no dialog, and the reason is simply that the form already
 * shows the failure. Every refusal this operation has lands somewhere visible — a wrong current
 * password under `currentPassword`, a `422` under the field the server named, and anything with no
 * field to land on in an `Alert` above them (`passwordChangeFailure`). A toast beside that is the
 * double signal `rules/errors-and-toasts.mdc` §2 forbids, and the one it duplicates is the one
 * attached to the input somebody has to fix. `logError` still runs: what an `onError` overrides is
 * the notification, never the journal (`rules/tanstack-query.mdc` §10).
 */
export const useChangePassword = (): UseMutationResult<void, Error, ChangePasswordRequest> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: ChangePasswordRequest) => changePassword(request),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Sessions.all });
      notify.success({ id: NOTIFICATION_ID, messageKey: 'security.password.done' });
    },

    onError: () => undefined,
  });
};
