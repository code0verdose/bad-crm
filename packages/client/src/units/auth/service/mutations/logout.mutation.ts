import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { logout } from '@units/auth/api';
import { clearAccessToken, emitAuthEvent } from '@units/auth/lib';
import { authSession } from '@units/auth/service/stores';

/**
 * Ends the session — server side if it can, this tab's side regardless.
 *
 * `onSettled`, not `onSuccess`, and that is the whole design. `POST /auth/logout` revokes the
 * session and clears the refresh cookie, but a tab that stays signed in because the network blinked
 * is worse than a tab that walks away from a session the server still holds: the second is a cookie
 * that expires, the first is an open workspace on a shared screen. The request is the best effort;
 * the local half is the guarantee.
 *
 * The local `onError` is not a stub. It is how a mutation tells the global `MutationCache.onError`
 * to stand aside (`rules/tanstack-query.mdc` §10), and standing aside is right here: the person
 * asked to sign out, and they are signed out. A red toast on the login screen saying the sign-out
 * failed would describe the request rather than what happened. The failure still reaches
 * `logError` — what is overridden is the notification, never the journal.
 *
 * `logged-out` is what `app/auth-events.util.ts` turns into the navigation and the cache wipe. This
 * layer does not know that a router exists.
 */
export const useLogoutMutation = (): UseMutationResult<void, Error, void> =>
  useMutation({
    mutationFn: () => logout(),

    onError: () => undefined,

    onSettled: () => {
      clearAccessToken();
      authSession.end();
      emitAuthEvent('logged-out');
    },
  });
