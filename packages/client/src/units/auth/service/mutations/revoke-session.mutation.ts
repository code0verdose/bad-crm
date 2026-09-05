import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { revokeSession } from '@units/auth/api';
import { clearAccessToken, emitAuthEvent } from '@units/auth/lib';
import { authSession } from '@units/auth/service/stores';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

const NOTIFICATION_ID = 'session-revoked';

export interface SessionRevocation {
  readonly sessionId: string;
  /**
   * Whether the row being closed is the one this tab is signed in with.
   *
   * Read from `SessionSummary.current`, which the server computes, rather than compared here against
   * anything the client stores: the id changes on every rotation, so a value this tab remembered
   * fifteen minutes ago names a row that is already revoked.
   */
  readonly isCurrent: boolean;
}

/**
 * Closes one session — **pessimistically**, and with two different endings.
 *
 * `rules/tanstack-query.mdc` §6 lists delete among the operations that are normally optimistic, and
 * this one deliberately is not. Removing the row before the server agrees would, in the case that
 * matters, remove the row the tab is *using*: a refusal would then have to put back a session that
 * the screen has already said is gone, on the screen somebody opened because they were worried about
 * exactly that. The list is short, the round trip is one request, and «it is still there» is the
 * honest state until the server says otherwise.
 *
 * **Closing the current session is signing out, and it is spelled that way.** The endpoint clears the
 * refresh cookie and denylists the session id, so the tab is anonymous the moment it answers; what
 * remains is the local half of `useLogoutMutation` — forget the token, end the session store,
 * announce `logged-out` — which `app/auth-events.util.ts` turns into the navigation and the cache
 * wipe. Doing it here rather than letting the next 401 discover it is the difference between leaving
 * on purpose and being thrown out.
 *
 * That ending gets **no toast**: the screen it would appear on is being replaced by the sign-in
 * form, and a green «session closed» on the login screen describes a request rather than what
 * happened. The other ending — somebody else's device, closed from this one — does get one, because
 * nothing else on screen would confirm it beyond a row quietly vanishing.
 *
 * **The local `onError` is what makes the dialog's own message the only signal.** The confirmation is
 * `aria-modal="true"`, so while it is open a toast in the corner is, for a screen-reader user, no
 * signal at all (`rules/tanstack-query.mdc` §10, `rules/errors-and-toasts.mdc` §2–§3).
 */
export const useRevokeSession = (): UseMutationResult<void, Error, SessionRevocation> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sessionId }: SessionRevocation) => revokeSession(sessionId),

    onSuccess: (_result, { isCurrent }) => {
      if (isCurrent) {
        clearAccessToken();
        authSession.end();
        emitAuthEvent('logged-out');

        return;
      }

      void queryClient.invalidateQueries({ queryKey: QueryKeys.Sessions.all });
      notify.success({ id: NOTIFICATION_ID, messageKey: 'security.sessions.done.revoked' });
    },

    onError: () => undefined,
  });
};
