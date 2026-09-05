import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { revokeOtherSessions, type RevokeOtherSessionsResult } from '@units/auth/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

const NOTIFICATION_ID = 'sessions-revoked';

/**
 * «I signed in on a machine that is not mine» — every other session closed, this one kept.
 *
 * **The count comes from the answer, not from the list.** `revokedCount` reports what *this* call
 * closed: a second run answers zero, and a device that expired between the read and the button was
 * never closed by anybody. Counting the rows on screen instead would produce a number that is right
 * only when nothing changed in between — and the number is the entire content of the message.
 *
 * Zero has its own sentence rather than an interpolated «0». It is not a failure and it is not rare:
 * it is what the second press produces, and «Closed 0 other sessions» reads as something having gone
 * wrong (`rules/i18n.mdc` §8).
 *
 * The list is invalidated rather than emptied locally: what is left is one row, and which row it is
 * is the server's answer.
 */
export const useRevokeOtherSessions = (): UseMutationResult<
  RevokeOtherSessionsResult,
  Error,
  void
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => revokeOtherSessions(),

    onSuccess: ({ revokedCount }) => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Sessions.all });
      notify.success(
        revokedCount === 0
          ? { id: NOTIFICATION_ID, messageKey: 'security.sessions.done.othersNone' }
          : {
              id: NOTIFICATION_ID,
              messageKey: 'security.sessions.done.others',
              values: { count: revokedCount },
            },
      );
    },

    // The confirmation is `aria-modal="true"`: a toast behind it is no signal at all, so the dialog
    // states the refusal itself and the global one stands aside (`rules/tanstack-query.mdc` §10).
    onError: () => undefined,
  });
};
