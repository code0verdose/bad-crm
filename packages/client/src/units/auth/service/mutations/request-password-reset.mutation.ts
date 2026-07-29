import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { requestPasswordReset, type ForgotPasswordRequest } from '@units/auth/api';

/**
 * Asks the server to mail a reset link.
 *
 * **No `onSuccess` notification.** The acceptance of the request *is* the screen — the form is
 * replaced by the sentence «if this address is registered, a message has been sent» — and a green
 * toast on top would be the second signal `rules/errors-and-toasts.mdc` §2 forbids. It would also be
 * a worse one: a toast that says «sent» reads as a fact about the address, which is exactly the
 * fact the operation refuses to disclose.
 *
 * **No `onError` either**, so the global `MutationCache.onError` keeps the single red toast for the
 * two refusals that exist here — `503 mail_not_configured` from an installation with no transport,
 * and `429` from the rate limiter. Neither says anything about the address: the 503 is decided
 * before it is resolved, and the 429 is per address *and* per IP with a constant answer.
 *
 * Nothing about the session changes: the caller is anonymous before and after.
 */
export const useRequestPasswordResetMutation = (): UseMutationResult<
  void,
  Error,
  ForgotPasswordRequest
> =>
  useMutation({
    mutationFn: (request: ForgotPasswordRequest) => requestPasswordReset(request),
  });
