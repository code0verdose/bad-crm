import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { SharedUi } from '@shared';

import { confirmPasswordReset, type ResetPasswordRequest } from '@units/auth/api';

/**
 * One id for the whole operation, so a retry updates the toast on screen instead of stacking a twin
 * beside it (`rules/errors-and-toasts.mdc` §6).
 */
const PASSWORD_RESET_NOTIFICATION_ID = 'auth-password-reset';

/** A key, never a sentence: the catalogue lands with EPIC-008 (`rules/i18n.mdc` §1). */
const PASSWORD_RESET_SUCCESS_KEY = 'auth.resetPassword.success';

/**
 * Sets a new password with the token from the mail.
 *
 * **The success toast is the only place the outcome can be said**, and that is why this mutation has
 * one where the request half does not: the screen it happened on is gone by the time the user reads
 * it. The server revokes every session of the account and issues none, so the person is sent to
 * `/login` — by the page, which owns navigation — and arrives at a form that looks exactly like the
 * one they could not get past a minute ago. Without a word from this operation, the reset would look
 * like it did nothing.
 *
 * **No local `onError`.** All three refusals go to the global `MutationCache.onError` as one red
 * toast keyed by `code` (`rules/errors-and-toasts.mdc` §3): `400 password_reset_token_invalid` for a
 * link that is unknown, already spent or expired — one answer for all three, deliberately — `422`
 * for a password the server's policy refuses, and `429`. Handling the first one inline would replace
 * that toast rather than add to it, and the other two would then have no signal at all; what the
 * screen offers instead is the standing link to ask for a new mail, which is the actionable half of
 * the only refusal a person can do anything about.
 */
export const useConfirmPasswordResetMutation = (): UseMutationResult<
  void,
  Error,
  ResetPasswordRequest
> =>
  useMutation({
    // `gcTime: 0`, because the arguments of *this* mutation are credentials.
    //
    // TanStack Query keeps `state.variables` beside `state.data` for the whole `gcTime` — five
    // minutes by default, counted from when the last observer unmounts. Here those variables are the
    // single-use reset token and the **plaintext new password**, and the cache is reachable without
    // importing anything: `@tanstack/router-core` assigns `self.__TSR_ROUTER__` for every router in a
    // document, under no development flag, and the `QueryClient` travels in the router context.
    //
    // The sibling `login.mutation.ts` takes the token out of the *answer* for that same reason; this
    // is the other half, and the more valuable one. An access token lives fifteen minutes and a spent
    // reset token is already dead, but a password is reusable and long-lived — and it would sit there
    // minutes after the person has finished and navigated away. Zeroing the window costs nothing:
    // nothing re-reads a completed password reset from the cache.
    gcTime: 0,

    mutationFn: (request: ResetPasswordRequest) => confirmPasswordReset(request),

    onSuccess: () => {
      SharedUi.notify.success({
        id: PASSWORD_RESET_NOTIFICATION_ID,
        messageKey: PASSWORD_RESET_SUCCESS_KEY,
      });
    },
  });
